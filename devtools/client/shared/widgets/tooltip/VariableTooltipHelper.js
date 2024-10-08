/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Set the tooltip content of a provided HTMLTooltip instance to display a
 * variable preview matching the provided text.
 *
 * @param  {HTMLTooltip} tooltip
 *         The tooltip instance on which the text preview content should be set.
 * @param  {Document} doc
 *         A document element to create the HTML elements needed for the tooltip.
 * @param  {Object} params
 * @param  {String} params.topSectionText
 *         Text to display in the top section of tooltip (e.g. "--x = blue" or "--x is not defined").
 * @param  {String} params.computed
 *         The computed value for the variable.
 * @param  {Object} params.registeredProperty
 *         Contains the registered property data, if the variable was registered (@property or CSS.registerProperty)
 * @param  {String} params.registeredProperty.syntax
 *         The registered property `syntax` value
 * @param  {Boolean} params.registeredProperty.inherits
 *         The registered property `inherits` value
 * @param  {String} params.registeredProperty.initialValue
 *         The registered property `initial-value`
 * @param  {String} params.startingStyle
 *         The text for @starting-style value (e.g. `--x = red`)
 */
function setVariableTooltip(
  tooltip,
  doc,
  { computed, topSectionText, registeredProperty, startingStyle }
) {
  // Create tooltip content
  const div = doc.createElementNS(XHTML_NS, "div");
  div.classList.add("devtools-monospace", "devtools-tooltip-css-variable");

  const valueEl = doc.createElementNS(XHTML_NS, "section");
  valueEl.classList.add("variable-value");
  valueEl.append(doc.createTextNode(topSectionText));
  div.appendChild(valueEl);

  if (typeof computed !== "undefined") {
    const section = doc.createElementNS(XHTML_NS, "section");
    section.classList.add("computed", "variable-tooltip-section");

    const h2 = doc.createElementNS(XHTML_NS, "h2");
    h2.append(doc.createTextNode("computed value"));
    const computedValueEl = doc.createElementNS(XHTML_NS, "div");
    computedValueEl.append(doc.createTextNode(computed));
    section.append(h2, computedValueEl);

    div.appendChild(section);
  }

  if (typeof startingStyle !== "undefined") {
    const section = doc.createElementNS(XHTML_NS, "section");
    section.classList.add("starting-style", "variable-tooltip-section");

    const h2 = doc.createElementNS(XHTML_NS, "h2");
    h2.append(doc.createTextNode("@starting-style"));
    const startingStyleValue = doc.createElementNS(XHTML_NS, "div");
    startingStyleValue.append(doc.createTextNode(startingStyle));
    section.append(h2, startingStyleValue);

    div.appendChild(section);
  }

  // A registered property always have a non-falsy syntax
  if (registeredProperty?.syntax) {
    const section = doc.createElementNS(XHTML_NS, "section");
    section.classList.add("registered-property", "variable-tooltip-section");

    const h2 = doc.createElementNS(XHTML_NS, "h2");
    h2.append(doc.createTextNode("@property"));

    const dl = doc.createElementNS(XHTML_NS, "dl");
    const addProperty = (label, value, lineBreak = true) => {
      const dt = doc.createElementNS(XHTML_NS, "dt");
      dt.append(doc.createTextNode(label));
      const dd = doc.createElementNS(XHTML_NS, "dd");
      dd.append(doc.createTextNode(value));
      dl.append(dt, dd);
      if (lineBreak) {
        dl.append(doc.createElementNS(XHTML_NS, "br"));
      }
    };

    const hasInitialValue = !!registeredProperty.initialValue;

    addProperty("syntax:", `"${registeredProperty.syntax}"`);
    addProperty("inherits:", registeredProperty.inherits, hasInitialValue);
    if (hasInitialValue) {
      addProperty("initial-value:", registeredProperty.initialValue, false);
    }

    section.append(h2, dl);
    div.appendChild(section);
  }

  tooltip.panel.innerHTML = "";
  tooltip.panel.appendChild(div);
  tooltip.setContentSize({ width: "auto", height: "auto" });
}

module.exports.setVariableTooltip = setVariableTooltip;
