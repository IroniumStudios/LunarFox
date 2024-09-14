/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "AppleVTDecoder.h"

#include <CoreVideo/CVPixelBufferIOSurface.h>
#include <IOSurface/IOSurfaceRef.h>
#include <limits>

#include "AOMDecoder.h"
#include "AppleDecoderModule.h"
#include "AppleUtils.h"
#include "CallbackThreadRegistry.h"
#include "H264.h"
#include "MP4Decoder.h"
#include "MacIOSurfaceImage.h"
#include "MediaData.h"
#include "VPXDecoder.h"
#include "VideoUtils.h"
#include "gfxMacUtils.h"
#include "mozilla/ArrayUtils.h"
#include "mozilla/Logging.h"
#include "mozilla/TaskQueue.h"
#include "mozilla/gfx/gfxVars.h"

#define LOG(...) DDMOZ_LOG(sPDMLog, mozilla::LogLevel::Debug, __VA_ARGS__)
#define LOGEX(_this, ...) \
  DDMOZ_LOGEX(_this, sPDMLog, mozilla::LogLevel::Debug, __VA_ARGS__)

namespace mozilla {

using namespace layers;

AppleVTDecoder::AppleVTDecoder(const VideoInfo& aConfig,
                               layers::ImageContainer* aImageContainer,
                               const CreateDecoderParams::OptionSet& aOptions,
                               layers::KnowsCompositor* aKnowsCompositor,
                               Maybe<TrackingId> aTrackingId)
    : mExtraData(aConfig.mExtraData),
      mPictureWidth(aConfig.mImage.width),
      mPictureHeight(aConfig.mImage.height),
      mDisplayWidth(aConfig.mDisplay.width),
      mDisplayHeight(aConfig.mDisplay.height),
      mColorSpace(aConfig.mColorSpace
                      ? *aConfig.mColorSpace
                      : DefaultColorSpace({mPictureWidth, mPictureHeight})),
      mColorPrimaries(aConfig.mColorPrimaries ? *aConfig.mColorPrimaries
                                              : gfx::ColorSpace2::BT709),
      mTransferFunction(aConfig.mTransferFunction
                            ? *aConfig.mTransferFunction
                            : gfx::TransferFunction::BT709),
      mColorRange(aConfig.mColorRange),
      mColorDepth(aConfig.mColorDepth),
      mStreamType(MP4Decoder::IsH264(aConfig.mMimeType)  ? StreamType::H264
                  : VPXDecoder::IsVP9(aConfig.mMimeType) ? StreamType::VP9
                  : AOMDecoder::IsAV1(aConfig.mMimeType) ? StreamType::AV1
                                                         : StreamType::Unknown),
      mTaskQueue(TaskQueue::Create(
          GetMediaThreadPool(MediaThreadType::PLATFORM_DECODER),
          "AppleVTDecoder")),
      mMaxRefFrames(
          mStreamType != StreamType::H264 ||
                  aOptions.contains(CreateDecoderParams::Option::LowLatency)
              ? 0
              : H264::ComputeMaxRefFrames(aConfig.mExtraData)),
      mImageContainer(aImageContainer),
      mKnowsCompositor(aKnowsCompositor)
#ifdef MOZ_WIDGET_UIKIT
      ,
      mUseSoftwareImages(true)
#else
      ,
      mUseSoftwareImages(aKnowsCompositor &&
                         aKnowsCompositor->GetWebRenderCompositorType() ==
                             layers::WebRenderCompositor::SOFTWARE)
#endif
      ,
      mTrackingId(aTrackingId),
      mIsFlushing(false),
      mCallbackThreadId(),
      mMonitor("AppleVTDecoder"),
      mPromise(&mMonitor),  // To ensure our PromiseHolder is only ever accessed
                            // with the monitor held.
      mFormat(nullptr),
      mSession(nullptr),
      mIsHardwareAccelerated(false) {
  MOZ_COUNT_CTOR(AppleVTDecoder);
  MOZ_ASSERT(mStreamType != StreamType::Unknown);
  // TODO: Verify aConfig.mime_type.
  LOG("Creating AppleVTDecoder for %dx%d %s video", mDisplayWidth,
      mDisplayHeight, EnumValueToString(mStreamType));
}

AppleVTDecoder::~AppleVTDecoder() { MOZ_COUNT_DTOR(AppleVTDecoder); }

RefPtr<MediaDataDecoder::InitPromise> AppleVTDecoder::Init() {
  MediaResult rv = InitializeSession();

  if (NS_SUCCEEDED(rv)) {
    return InitPromise::CreateAndResolve(TrackType::kVideoTrack, __func__);
  }

  return InitPromise::CreateAndReject(rv, __func__);
}

RefPtr<MediaDataDecoder::DecodePromise> AppleVTDecoder::Decode(
    MediaRawData* aSample) {
  LOG("mp4 input sample %p pts %lld duration %lld us%s %zu bytes", aSample,
      aSample->mTime.ToMicroseconds(), aSample->mDuration.ToMicroseconds(),
      aSample->mKeyframe ? " keyframe" : "", aSample->Size());

  RefPtr<AppleVTDecoder> self = this;
  RefPtr<MediaRawData> sample = aSample;
  return InvokeAsync(mTaskQueue, __func__, [self, this, sample] {
    RefPtr<DecodePromise> p;
    {
      MonitorAutoLock mon(mMonitor);
      p = mPromise.Ensure(__func__);
    }
    ProcessDecode(sample);
    return p;
  });
}

RefPtr<MediaDataDecoder::FlushPromise> AppleVTDecoder::Flush() {
  mIsFlushing = true;
  return InvokeAsync(mTaskQueue, this, __func__, &AppleVTDecoder::ProcessFlush);
}

RefPtr<MediaDataDecoder::DecodePromise> AppleVTDecoder::Drain() {
  return InvokeAsync(mTaskQueue, this, __func__, &AppleVTDecoder::ProcessDrain);
}

RefPtr<ShutdownPromise> AppleVTDecoder::Shutdown() {
  RefPtr<AppleVTDecoder> self = this;
  return InvokeAsync(mTaskQueue, __func__, [self]() {
    self->ProcessShutdown();
    return self->mTaskQueue->BeginShutdown();
  });
}

// Helper to fill in a timestamp structure.
static CMSampleTimingInfo TimingInfoFromSample(MediaRawData* aSample) {
  CMSampleTimingInfo timestamp;

  timestamp.duration =
      CMTimeMake(aSample->mDuration.ToMicroseconds(), USECS_PER_S);
  timestamp.presentationTimeStamp =
      CMTimeMake(aSample->mTime.ToMicroseconds(), USECS_PER_S);
  timestamp.decodeTimeStamp =
      CMTimeMake(aSample->mTimecode.ToMicroseconds(), USECS_PER_S);

  return timestamp;
}

void AppleVTDecoder::ProcessDecode(MediaRawData* aSample) {
  AssertOnTaskQueue();
  PROCESS_DECODE_LOG(aSample);

  if (mIsFlushing) {
    MonitorAutoLock mon(mMonitor);
    mPromise.Reject(NS_ERROR_DOM_MEDIA_CANCELED, __func__);
    return;
  }

  mTrackingId.apply([&](const auto& aId) {
    MediaInfoFlag flag = MediaInfoFlag::None;
    flag |= (aSample->mKeyframe ? MediaInfoFlag::KeyFrame
                                : MediaInfoFlag::NonKeyFrame);
    flag |= (mIsHardwareAccelerated ? MediaInfoFlag::HardwareDecoding
                                    : MediaInfoFlag::SoftwareDecoding);
    switch (mStreamType) {
      case StreamType::H264:
        flag |= MediaInfoFlag::VIDEO_H264;
        break;
      case StreamType::VP9:
        flag |= MediaInfoFlag::VIDEO_VP9;
        break;
      case StreamType::AV1:
        flag |= MediaInfoFlag::VIDEO_AV1;
        break;
      default:
        break;
    }
    mPerformanceRecorder.Start(aSample->mTimecode.ToMicroseconds(),
                               "AppleVTDecoder"_ns, aId, flag);
  });

  AutoCFRelease<CMBlockBufferRef> block = nullptr;
  AutoCFRelease<CMSampleBufferRef> sample = nullptr;
  VTDecodeInfoFlags infoFlags;
  OSStatus rv;

  // FIXME: This copies the sample data. I think we can provide
  // a custom block source which reuses the aSample buffer.
  // But note that there may be a problem keeping the samples
  // alive over multiple frames.
  rv = CMBlockBufferCreateWithMemoryBlock(
      kCFAllocatorDefault,  // Struct allocator.
      const_cast<uint8_t*>(aSample->Data()), aSample->Size(),
      kCFAllocatorNull,  // Block allocator.
      NULL,              // Block source.
      0,                 // Data offset.
      aSample->Size(), false, block.receive());
  if (rv != noErr) {
    NS_ERROR("Couldn't create CMBlockBuffer");
    MonitorAutoLock mon(mMonitor);
    mPromise.Reject(
        MediaResult(NS_ERROR_OUT_OF_MEMORY,
                    RESULT_DETAIL("CMBlockBufferCreateWithMemoryBlock:%x", rv)),
        __func__);
    return;
  }

  CMSampleTimingInfo timestamp = TimingInfoFromSample(aSample);
  rv = CMSampleBufferCreate(kCFAllocatorDefault, block, true, 0, 0, mFormat, 1,
                            1, &timestamp, 0, NULL, sample.receive());
  if (rv != noErr) {
    NS_ERROR("Couldn't create CMSampleBuffer");
    MonitorAutoLock mon(mMonitor);
    mPromise.Reject(MediaResult(NS_ERROR_OUT_OF_MEMORY,
                                RESULT_DETAIL("CMSampleBufferCreate:%x", rv)),
                    __func__);
    return;
  }

  VTDecodeFrameFlags decodeFlags =
      kVTDecodeFrame_EnableAsynchronousDecompression;
  rv = VTDecompressionSessionDecodeFrame(
      mSession, sample, decodeFlags, CreateAppleFrameRef(aSample), &infoFlags);
  if (infoFlags & kVTDecodeInfo_FrameDropped) {
    MonitorAutoLock mon(mMonitor);
    // Smile and nod
    NS_WARNING("Decoder synchronously dropped frame");
    MaybeResolveBufferedFrames();
    return;
  }

  if (rv != noErr) {
    LOG("AppleVTDecoder: Error %d VTDecompressionSessionDecodeFrame", rv);
    NS_WARNING("Couldn't pass frame to decoder");
    // It appears that even when VTDecompressionSessionDecodeFrame returned a
    // failure. Decoding sometimes actually get processed.
    MonitorAutoLock mon(mMonitor);
    mPromise.RejectIfExists(
        MediaResult(NS_ERROR_DOM_MEDIA_DECODE_ERR,
                    RESULT_DETAIL("VTDecompressionSessionDecodeFrame:%x", rv)),
        __func__);
    return;
  }
}

void AppleVTDecoder::ProcessShutdown() {
  if (mSession) {
    LOG("%s: cleaning up session %p", __func__, mSession);
    VTDecompressionSessionInvalidate(mSession);
    CFRelease(mSession);
    mSession = nullptr;
  }
  if (mFormat) {
    LOG("%s: releasing format %p", __func__, mFormat);
    CFRelease(mFormat);
    mFormat = nullptr;
  }
}

RefPtr<MediaDataDecoder::FlushPromise> AppleVTDecoder::ProcessFlush() {
  AssertOnTaskQueue();
  nsresult rv = WaitForAsynchronousFrames();
  if (NS_FAILED(rv)) {
    LOG("AppleVTDecoder::Flush failed waiting for platform decoder");
  }
  MonitorAutoLock mon(mMonitor);
  mPromise.RejectIfExists(NS_ERROR_DOM_MEDIA_CANCELED, __func__);

  while (!mReorderQueue.IsEmpty()) {
    mReorderQueue.Pop();
  }
  mPerformanceRecorder.Record(std::numeric_limits<int64_t>::max());
  mSeekTargetThreshold.reset();
  mIsFlushing = false;
  return FlushPromise::CreateAndResolve(true, __func__);
}

RefPtr<MediaDataDecoder::DecodePromise> AppleVTDecoder::ProcessDrain() {
  AssertOnTaskQueue();
  nsresult rv = WaitForAsynchronousFrames();
  if (NS_FAILED(rv)) {
    LOG("AppleVTDecoder::Drain failed waiting for platform decoder");
  }
  MonitorAutoLock mon(mMonitor);
  DecodedData samples;
  while (!mReorderQueue.IsEmpty()) {
    samples.AppendElement(mReorderQueue.Pop());
  }
  return DecodePromise::CreateAndResolve(std::move(samples), __func__);
}

AppleVTDecoder::AppleFrameRef* AppleVTDecoder::CreateAppleFrameRef(
    const MediaRawData* aSample) {
  MOZ_ASSERT(aSample);
  return new AppleFrameRef(*aSample);
}

void AppleVTDecoder::SetSeekThreshold(const media::TimeUnit& aTime) {
  if (aTime.IsValid()) {
    mSeekTargetThreshold = Some(aTime);
  } else {
    mSeekTargetThreshold.reset();
  }
}

//
// Implementation details.
//

// Callback passed to the VideoToolbox decoder for returning data.
// This needs to be static because the API takes a C-style pair of
// function and userdata pointers. This validates parameters and
// forwards the decoded image back to an object method.
static void PlatformCallback(void* decompressionOutputRefCon,
                             void* sourceFrameRefCon, OSStatus status,
                             VTDecodeInfoFlags flags, CVImageBufferRef image,
                             CMTime presentationTimeStamp,
                             CMTime presentationDuration) {
  AppleVTDecoder* decoder =
      static_cast<AppleVTDecoder*>(decompressionOutputRefCon);
  LOGEX(decoder, "AppleVideoDecoder %s status %d flags %d", __func__,
        static_cast<int>(status), flags);

  UniquePtr<AppleVTDecoder::AppleFrameRef> frameRef(
      static_cast<AppleVTDecoder::AppleFrameRef*>(sourceFrameRefCon));

  // Validate our arguments.
  if (status != noErr) {
    NS_WARNING("VideoToolbox decoder returned an error");
    decoder->OnDecodeError(status);
    return;
  }
  if (!image) {
    NS_WARNING("VideoToolbox decoder returned no data");
  } else if (flags & kVTDecodeInfo_FrameDropped) {
    NS_WARNING("  ...frame tagged as dropped...");
  } else {
    MOZ_ASSERT(CFGetTypeID(image) == CVPixelBufferGetTypeID(),
               "VideoToolbox returned an unexpected image type");
  }

  decoder->OutputFrame(image, *frameRef);
}

void AppleVTDecoder::MaybeResolveBufferedFrames() {
  mMonitor.AssertCurrentThreadOwns();

  if (mPromise.IsEmpty()) {
    return;
  }

  DecodedData results;
  while (mReorderQueue.Length() > mMaxRefFrames) {
    results.AppendElement(mReorderQueue.Pop());
  }
  mPromise.Resolve(std::move(results), __func__);
}

void AppleVTDecoder::MaybeRegisterCallbackThread() {
  ProfilerThreadId id = profiler_current_thread_id();
  if (MOZ_LIKELY(id == mCallbackThreadId)) {
    return;
  }
  mCallbackThreadId = id;
  CallbackThreadRegistry::Get()->Register(mCallbackThreadId,
                                          "AppleVTDecoderCallback");
}

nsCString AppleVTDecoder::GetCodecName() const {
  return nsCString(EnumValueToString(mStreamType));
}

// Copy and return a decoded frame.
void AppleVTDecoder::OutputFrame(CVPixelBufferRef aImage,
                                 AppleVTDecoder::AppleFrameRef aFrameRef) {
  MaybeRegisterCallbackThread();

  if (mIsFlushing) {
    // We are in the process of flushing or shutting down; ignore frame.
    return;
  }

  LOG("mp4 output frame %lld dts %lld pts %lld duration %lld us%s",
      aFrameRef.byte_offset, aFrameRef.decode_timestamp.ToMicroseconds(),
      aFrameRef.composition_timestamp.ToMicroseconds(),
      aFrameRef.duration.ToMicroseconds(),
      aFrameRef.is_sync_point ? " keyframe" : "");

  if (!aImage) {
    // Image was dropped by decoder or none return yet.
    // We need more input to continue.
    MonitorAutoLock mon(mMonitor);
    MaybeResolveBufferedFrames();
    return;
  }

  bool useNullSample = false;
  if (mSeekTargetThreshold.isSome()) {
    if ((aFrameRef.composition_timestamp + aFrameRef.duration) <
        mSeekTargetThreshold.ref()) {
      useNullSample = true;
    } else {
      mSeekTargetThreshold.reset();
    }
  }

  // Where our resulting image will end up.
  RefPtr<MediaData> data;
  // Bounds.
  VideoInfo info;
  info.mDisplay = gfx::IntSize(mDisplayWidth, mDisplayHeight);

  if (useNullSample) {
    data = new NullData(aFrameRef.byte_offset, aFrameRef.composition_timestamp,
                        aFrameRef.duration);
  } else if (mUseSoftwareImages) {
    size_t width = CVPixelBufferGetWidth(aImage);
    size_t height = CVPixelBufferGetHeight(aImage);
    DebugOnly<size_t> planes = CVPixelBufferGetPlaneCount(aImage);
    MOZ_ASSERT(planes == 3, "Likely not YUV420 format and it must be.");

    VideoData::YCbCrBuffer buffer;

    // Lock the returned image data.
    CVReturn rv =
        CVPixelBufferLockBaseAddress(aImage, kCVPixelBufferLock_ReadOnly);
    if (rv != kCVReturnSuccess) {
      NS_ERROR("error locking pixel data");
      MonitorAutoLock mon(mMonitor);
      mPromise.Reject(
          MediaResult(NS_ERROR_DOM_MEDIA_DECODE_ERR,
                      RESULT_DETAIL("CVPixelBufferLockBaseAddress:%x", rv)),
          __func__);
      return;
    }
    // Y plane.
    buffer.mPlanes[0].mData =
        static_cast<uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(aImage, 0));
    buffer.mPlanes[0].mStride = CVPixelBufferGetBytesPerRowOfPlane(aImage, 0);
    buffer.mPlanes[0].mWidth = width;
    buffer.mPlanes[0].mHeight = height;
    buffer.mPlanes[0].mSkip = 0;
    // Cb plane.
    buffer.mPlanes[1].mData =
        static_cast<uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(aImage, 1));
    buffer.mPlanes[1].mStride = CVPixelBufferGetBytesPerRowOfPlane(aImage, 1);
    buffer.mPlanes[1].mWidth = (width + 1) / 2;
    buffer.mPlanes[1].mHeight = (height + 1) / 2;
    buffer.mPlanes[1].mSkip = 0;
    // Cr plane.
    buffer.mPlanes[2].mData =
        static_cast<uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(aImage, 2));
    buffer.mPlanes[2].mStride = CVPixelBufferGetBytesPerRowOfPlane(aImage, 2);
    buffer.mPlanes[2].mWidth = (width + 1) / 2;
    buffer.mPlanes[2].mHeight = (height + 1) / 2;
    buffer.mPlanes[2].mSkip = 0;

    buffer.mChromaSubsampling = gfx::ChromaSubsampling::HALF_WIDTH_AND_HEIGHT;
    buffer.mYUVColorSpace = mColorSpace;
    buffer.mColorPrimaries = mColorPrimaries;
    buffer.mColorRange = mColorRange;

    gfx::IntRect visible = gfx::IntRect(0, 0, mPictureWidth, mPictureHeight);

    // Copy the image data into our own format.
    Result<already_AddRefed<VideoData>, MediaResult> result =
        VideoData::CreateAndCopyData(
            info, mImageContainer, aFrameRef.byte_offset,
            aFrameRef.composition_timestamp, aFrameRef.duration, buffer,
            aFrameRef.is_sync_point, aFrameRef.decode_timestamp, visible,
            mKnowsCompositor);
    // TODO: Reject mPromise below with result's error return.
    data = result.unwrapOr(nullptr);
    // Unlock the returned image data.
    CVPixelBufferUnlockBaseAddress(aImage, kCVPixelBufferLock_ReadOnly);
  } else {
    // Set pixel buffer properties on aImage before we extract its surface.
    // This ensures that we can use defined enums to set values instead
    // of later setting magic CFSTR values on the surface itself.
    if (mColorSpace == gfx::YUVColorSpace::BT601) {
      CVBufferSetAttachment(aImage, kCVImageBufferYCbCrMatrixKey,
                            kCVImageBufferYCbCrMatrix_ITU_R_601_4,
                            kCVAttachmentMode_ShouldPropagate);
    } else if (mColorSpace == gfx::YUVColorSpace::BT709) {
      CVBufferSetAttachment(aImage, kCVImageBufferYCbCrMatrixKey,
                            kCVImageBufferYCbCrMatrix_ITU_R_709_2,
                            kCVAttachmentMode_ShouldPropagate);
    } else if (mColorSpace == gfx::YUVColorSpace::BT2020) {
      CVBufferSetAttachment(aImage, kCVImageBufferYCbCrMatrixKey,
                            kCVImageBufferYCbCrMatrix_ITU_R_2020,
                            kCVAttachmentMode_ShouldPropagate);
    }

    if (mColorPrimaries == gfx::ColorSpace2::BT709) {
      CVBufferSetAttachment(aImage, kCVImageBufferColorPrimariesKey,
                            kCVImageBufferColorPrimaries_ITU_R_709_2,
                            kCVAttachmentMode_ShouldPropagate);
    } else if (mColorPrimaries == gfx::ColorSpace2::BT2020) {
      CVBufferSetAttachment(aImage, kCVImageBufferColorPrimariesKey,
                            kCVImageBufferColorPrimaries_ITU_R_2020,
                            kCVAttachmentMode_ShouldPropagate);
    }

    // Transfer function is applied independently from the colorSpace.
    CVBufferSetAttachment(
        aImage, kCVImageBufferTransferFunctionKey,
        gfxMacUtils::CFStringForTransferFunction(mTransferFunction),
        kCVAttachmentMode_ShouldPropagate);

    CFTypeRefPtr<IOSurfaceRef> surface =
        CFTypeRefPtr<IOSurfaceRef>::WrapUnderGetRule(
            CVPixelBufferGetIOSurface(aImage));
    MOZ_ASSERT(surface, "Decoder didn't return an IOSurface backed buffer");

    RefPtr<MacIOSurface> macSurface = new MacIOSurface(std::move(surface));
    macSurface->SetYUVColorSpace(mColorSpace);
    macSurface->mColorPrimaries = mColorPrimaries;

    RefPtr<layers::Image> image = new layers::MacIOSurfaceImage(macSurface);

    data = VideoData::CreateFromImage(
        info.mDisplay, aFrameRef.byte_offset, aFrameRef.composition_timestamp,
        aFrameRef.duration, image.forget(), aFrameRef.is_sync_point,
        aFrameRef.decode_timestamp);
  }

  if (!data) {
    NS_ERROR("Couldn't create VideoData for frame");
    MonitorAutoLock mon(mMonitor);
    mPromise.Reject(MediaResult(NS_ERROR_OUT_OF_MEMORY, __func__), __func__);
    return;
  }

  mPerformanceRecorder.Record(
      aFrameRef.decode_timestamp.ToMicroseconds(), [&](DecodeStage& aStage) {
        aStage.SetResolution(static_cast<int>(CVPixelBufferGetWidth(aImage)),
                             static_cast<int>(CVPixelBufferGetHeight(aImage)));
        auto format = [&]() -> Maybe<DecodeStage::ImageFormat> {
          switch (CVPixelBufferGetPixelFormatType(aImage)) {
            case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:
            case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
              return Some(DecodeStage::NV12);
            case kCVPixelFormatType_422YpCbCr8_yuvs:
            case kCVPixelFormatType_422YpCbCr8FullRange:
              return Some(DecodeStage::YUV422P);
            case kCVPixelFormatType_32BGRA:
              return Some(DecodeStage::RGBA32);
            default:
              return Nothing();
          }
        }();
        format.apply([&](auto aFormat) { aStage.SetImageFormat(aFormat); });
        aStage.SetColorDepth(mColorDepth);
        aStage.SetYUVColorSpace(mColorSpace);
        aStage.SetColorRange(mColorRange);
        aStage.SetStartTimeAndEndTime(data->mTime.ToMicroseconds(),
                                      data->GetEndTime().ToMicroseconds());
      });

  // Frames come out in DTS order but we need to output them
  // in composition order.
  MonitorAutoLock mon(mMonitor);
  mReorderQueue.Push(std::move(data));
  MaybeResolveBufferedFrames();

  LOG("%llu decoded frames queued",
      static_cast<unsigned long long>(mReorderQueue.Length()));
}

void AppleVTDecoder::OnDecodeError(OSStatus aError) {
  MonitorAutoLock mon(mMonitor);
  mPromise.RejectIfExists(
      MediaResult(NS_ERROR_DOM_MEDIA_DECODE_ERR,
                  RESULT_DETAIL("OnDecodeError:%x", aError)),
      __func__);
}

nsresult AppleVTDecoder::WaitForAsynchronousFrames() {
  OSStatus rv = VTDecompressionSessionWaitForAsynchronousFrames(mSession);
  if (rv != noErr) {
    NS_ERROR("AppleVTDecoder: Error waiting for asynchronous frames");
    return NS_ERROR_FAILURE;
  }
  return NS_OK;
}

MediaResult AppleVTDecoder::InitializeSession() {
  OSStatus rv;

  AutoCFRelease<CFDictionaryRef> extensions = CreateDecoderExtensions();
  CMVideoCodecType streamType;
  if (mStreamType == StreamType::H264) {
    streamType = kCMVideoCodecType_H264;
  } else if (mStreamType == StreamType::VP9) {
    streamType = CMVideoCodecType(AppleDecoderModule::kCMVideoCodecType_VP9);
  } else {
    streamType = kCMVideoCodecType_AV1;
  }

  rv = CMVideoFormatDescriptionCreate(
      kCFAllocatorDefault, streamType, AssertedCast<int32_t>(mPictureWidth),
      AssertedCast<int32_t>(mPictureHeight), extensions, &mFormat);
  if (rv != noErr) {
    return MediaResult(NS_ERROR_DOM_MEDIA_FATAL_ERR,
                       RESULT_DETAIL("Couldn't create format description!"));
  }

  // Contruct video decoder selection spec.
  AutoCFRelease<CFDictionaryRef> spec = CreateDecoderSpecification();

  // Contruct output configuration.
  AutoCFRelease<CFDictionaryRef> outputConfiguration =
      CreateOutputConfiguration();

  VTDecompressionOutputCallbackRecord cb = {PlatformCallback, this};
  rv =
      VTDecompressionSessionCreate(kCFAllocatorDefault, mFormat,
                                   spec,  // Video decoder selection.
                                   outputConfiguration,  // Output video format.
                                   &cb, &mSession);

  if (rv != noErr) {
    LOG("AppleVTDecoder: VTDecompressionSessionCreate failed: %d", rv);
    return MediaResult(NS_ERROR_DOM_MEDIA_FATAL_ERR,
                       RESULT_DETAIL("Couldn't create decompression session!"));
  }

  CFBooleanRef isUsingHW = nullptr;
  rv = VTSessionCopyProperty(
      mSession,
      kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
      kCFAllocatorDefault, &isUsingHW);
  if (rv == noErr) {
    mIsHardwareAccelerated = isUsingHW == kCFBooleanTrue;
    LOG("AppleVTDecoder: %s hardware accelerated decoding",
        mIsHardwareAccelerated ? "using" : "not using");
  } else {
    LOG("AppleVTDecoder: maybe hardware accelerated decoding "
        "(VTSessionCopyProperty query failed)");
  }
  if (isUsingHW) {
    CFRelease(isUsingHW);
  }

  return NS_OK;
}

CFDictionaryRef AppleVTDecoder::CreateDecoderExtensions() {
  AutoCFRelease<CFDataRef> data =
      CFDataCreate(kCFAllocatorDefault, mExtraData->Elements(),
                   AssertedCast<CFIndex>(mExtraData->Length()));

  const void* atomsKey[1];
  atomsKey[0] = mStreamType == StreamType::H264  ? CFSTR("avcC")
                : mStreamType == StreamType::VP9 ? CFSTR("vpcC")
                                                 : CFSTR("av1C");
  ;
  const void* atomsValue[] = {data};
  static_assert(ArrayLength(atomsKey) == ArrayLength(atomsValue),
                "Non matching keys/values array size");

  AutoCFRelease<CFDictionaryRef> atoms = CFDictionaryCreate(
      kCFAllocatorDefault, atomsKey, atomsValue, ArrayLength(atomsKey),
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);

  const void* extensionKeys[] = {
      kCVImageBufferChromaLocationBottomFieldKey,
      kCVImageBufferChromaLocationTopFieldKey,
      kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms};

  const void* extensionValues[] = {kCVImageBufferChromaLocation_Left,
                                   kCVImageBufferChromaLocation_Left, atoms};
  static_assert(ArrayLength(extensionKeys) == ArrayLength(extensionValues),
                "Non matching keys/values array size");

  return CFDictionaryCreate(kCFAllocatorDefault, extensionKeys, extensionValues,
                            ArrayLength(extensionKeys),
                            &kCFTypeDictionaryKeyCallBacks,
                            &kCFTypeDictionaryValueCallBacks);
}

CFDictionaryRef AppleVTDecoder::CreateDecoderSpecification() {
  const void* specKeys[] = {
      kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder};
  const void* specValues[1];
  if (gfx::gfxVars::CanUseHardwareVideoDecoding()) {
    specValues[0] = kCFBooleanTrue;
  } else {
    // This GPU is blacklisted for hardware decoding.
    specValues[0] = kCFBooleanFalse;
  }
  static_assert(ArrayLength(specKeys) == ArrayLength(specValues),
                "Non matching keys/values array size");

  return CFDictionaryCreate(
      kCFAllocatorDefault, specKeys, specValues, ArrayLength(specKeys),
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
}

CFDictionaryRef AppleVTDecoder::CreateOutputConfiguration() {
  if (mUseSoftwareImages) {
    // Output format type:
    SInt32 PixelFormatTypeValue = kCVPixelFormatType_420YpCbCr8Planar;
    AutoCFRelease<CFNumberRef> PixelFormatTypeNumber = CFNumberCreate(
        kCFAllocatorDefault, kCFNumberSInt32Type, &PixelFormatTypeValue);
    const void* outputKeys[] = {kCVPixelBufferPixelFormatTypeKey};
    const void* outputValues[] = {PixelFormatTypeNumber};
    static_assert(ArrayLength(outputKeys) == ArrayLength(outputValues),
                  "Non matching keys/values array size");

    return CFDictionaryCreate(
        kCFAllocatorDefault, outputKeys, outputValues, ArrayLength(outputKeys),
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  }

  // Output format type:

  bool is10Bit = (gfx::BitDepthForColorDepth(mColorDepth) == 10);
  SInt32 PixelFormatTypeValue =
      mColorRange == gfx::ColorRange::FULL
          ? (is10Bit ? kCVPixelFormatType_420YpCbCr10BiPlanarFullRange
                     : kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)
          : (is10Bit ? kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
                     : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
  AutoCFRelease<CFNumberRef> PixelFormatTypeNumber = CFNumberCreate(
      kCFAllocatorDefault, kCFNumberSInt32Type, &PixelFormatTypeValue);
  // Construct IOSurface Properties
  const void* IOSurfaceKeys[] = {kIOSurfaceIsGlobal};
  const void* IOSurfaceValues[] = {kCFBooleanTrue};
  static_assert(ArrayLength(IOSurfaceKeys) == ArrayLength(IOSurfaceValues),
                "Non matching keys/values array size");

  // Contruct output configuration.
  AutoCFRelease<CFDictionaryRef> IOSurfaceProperties = CFDictionaryCreate(
      kCFAllocatorDefault, IOSurfaceKeys, IOSurfaceValues,
      ArrayLength(IOSurfaceKeys), &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);

  const void* outputKeys[] = {kCVPixelBufferIOSurfacePropertiesKey,
                              kCVPixelBufferPixelFormatTypeKey,
                              kCVPixelBufferOpenGLCompatibilityKey};
  const void* outputValues[] = {IOSurfaceProperties, PixelFormatTypeNumber,
                                kCFBooleanTrue};
  static_assert(ArrayLength(outputKeys) == ArrayLength(outputValues),
                "Non matching keys/values array size");

  return CFDictionaryCreate(
      kCFAllocatorDefault, outputKeys, outputValues, ArrayLength(outputKeys),
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
}

}  // namespace mozilla

#undef LOG
#undef LOGEX
