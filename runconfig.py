import os
import subprocess

def run_executable():
    # Get the directory of the current script
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Define the relative path to the executable
    relative_path = os.path.join('obj-x86_64-pc-windows-msvc', 'dist', 'bin', 'lunarfox.exe')
    
    # Construct the absolute path to the executable
    exe_path = os.path.join(script_dir, relative_path)
    
    # Check if the executable exists
    if not os.path.isfile(exe_path):
        print(f"Error: The executable was not found at {exe_path}")
        return
    
    # Run the executable
    try:
        subprocess.run(exe_path, check=True)
    except subprocess.CalledProcessError as e:
        print(f"Error: The executable failed with error {e}")

if __name__ == '__main__':
    run_executable()
