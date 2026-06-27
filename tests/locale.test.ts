import { describe, expect, it } from "vitest";
import { resolveRegion, ddgRegion, acceptLanguageHeader, baseLang } from "../src/locale.js";

describe("baseLang", () => {
  it("lowercases and strips the region subtag", () => {
    expect(baseLang("de-DE")).toBe("de");
    expect(baseLang("EN")).toBe("en");
    expect(baseLang(undefined)).toBe("en");
  });
});

describe("resolveRegion", () => {
  it("mirrors the language for most locales", () => {
    expect(resolveRegion("de")).toBe("de");
    expect(resolveRegion("fr")).toBe("fr");
  });
  it("maps languages whose country differs", () => {
    expect(resolveRegion("en")).toBe("us");
    expect(resolveRegion("pt")).toBe("br");
    expect(resolveRegion("ja")).toBe("jp");
  });
  it("honors an explicit region override", () => {
    expect(resolveRegion("en", "de")).toBe("de");
    expect(resolveRegion("en", "GB")).toBe("gb");
  });
  it("uses a region subtag carried on the lang", () => {
    expect(resolveRegion("de-AT")).toBe("at");
  });
});

describe("ddgRegion (kl = region-language)", () => {
  it("builds de-de, fr-fr, us-en", () => {
    expect(ddgRegion("de")).toBe("de-de");
    expect(ddgRegion("fr")).toBe("fr-fr");
    expect(ddgRegion("en")).toBe("us-en");
  });
  it("aliases gb → uk for DuckDuckGo", () => {
    expect(ddgRegion("en", "gb")).toBe("uk-en");
  });
  it("combines an explicit region with the language", () => {
    expect(ddgRegion("en", "de")).toBe("de-en");
  });
});

describe("acceptLanguageHeader", () => {
  it("biases to the target language with English fallback", () => {
    expect(acceptLanguageHeader("de")).toBe("de-DE,de;q=0.9,en;q=0.5");
    expect(acceptLanguageHeader("fr", "ca")).toBe("fr-CA,fr;q=0.9,en;q=0.5");
  });
  it("does not duplicate English for an English search", () => {
    expect(acceptLanguageHeader("en")).toBe("en-US,en;q=0.9");
  });
});
