// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseCardigannYaml, cardigannDefinitionStatus, cardigannUnknownTemplateFunctions } from "./index";

function def(yaml: string): ReturnType<typeof parseCardigannYaml> {
  return parseCardigannYaml(yaml);
}

const CLEAN = `name: Clean
settings:
  - name: baseUrl
    type: text
search:
  paths:
    - path: browse.php
      inputs:
        q: "{{ .Keywords }}"
  rows:
    selector: tr.row
  fields:
    title:
      selector: td.t
`;

const CAPTCHA = `name: CaptchaSite
login:
  method: post
  path: login
  captcha:
    type: image
    selector: img
    input: code
search:
  paths:
    - path: browse.php
  rows:
    selector: tr
  fields:
    title:
      selector: td
`;

const BAD_TPL = `name: BadTpl
search:
  paths:
    - path: "x{{ printf .Keywords }}"
  rows:
    selector: tr
  fields:
    title:
      selector: td
`;

const BAD_FILTER = `name: BadFilter
search:
  paths:
    - path: /browse
  rows:
    selector: tr
  fields:
    title:
      selector: td
      filters:
        - name: strdump
`;

describe("cardigannDefinitionStatus (sync-job tagging)", () => {
  it("marks a fully-supported definition as supported", () => {
    const s = cardigannDefinitionStatus(def(CLEAN));
    expect(s.supported).toBe(true);
    expect(s.reasons).toEqual([]);
    expect(cardigannUnknownTemplateFunctions(def(CLEAN))).toEqual([]);
  });

  it("flags captcha-gated definitions as unsupported", () => {
    const s = cardigannDefinitionStatus(def(CAPTCHA));
    expect(s.supported).toBe(false);
    expect(s.reasons.join(" ")).toContain("captcha");
  });

  it("flags definitions using an unknown template function as unsupported", () => {
    const d = def(BAD_TPL);
    expect(cardigannUnknownTemplateFunctions(d)).toContain("printf");
    const s = cardigannDefinitionStatus(d);
    expect(s.supported).toBe(false);
    expect(s.reasons.join(" ")).toContain("printf");
  });

  it("flags definitions using an unimplemented filter as unsupported", () => {
    const s = cardigannDefinitionStatus(def(BAD_FILTER));
    expect(s.supported).toBe(false);
    expect(s.reasons.join(" ")).toContain("strdump");
  });
});
