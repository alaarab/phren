import { describe, expect, it } from "vitest";
import { porterStem } from "./stemmer.js";

describe("porterStem", () => {
  describe("plurals", () => {
    it.each([
      ["classes", "class"],
      ["ponies", "poni"],
    ])("stems '%s' to '%s'", (word, stem) => {
      expect(porterStem(word)).toBe(stem);
    });
  });

  describe("-ing", () => {
    it.each([
      ["hopping", "hop"],
      ["filing", "file"],
    ])("stems '%s' to '%s'", (word, stem) => {
      expect(porterStem(word)).toBe(stem);
    });
  });

  describe("-ed", () => {
    it.each([
      ["agreed", "agre"],
      ["conflated", "conflat"],
    ])("stems '%s' to '%s'", (word, stem) => {
      expect(porterStem(word)).toBe(stem);
    });
  });

  describe("-y and -ly", () => {
    it.each([
      ["happy", "happi"],
      ["quickly", "quickli"],
    ])("stems '%s' to '%s'", (word, stem) => {
      expect(porterStem(word)).toBe(stem);
    });
  });

  describe("step 2 suffixes", () => {
    it.each([
      ["organization", "organ"],
      ["communication", "commun"],
      ["capitalism", "capit"],
      ["formality", "formal"],
      ["possibility", "possibl"],
    ])("stems '%s' to '%s'", (word, stem) => {
      expect(porterStem(word)).toBe(stem);
    });
  });

  describe("step 3 suffixes", () => {
    it.each([
      ["duplicate", "duplic"],
      ["logical", "logic"],
      ["goodness", "good"],
    ])("stems '%s' to '%s'", (word, stem) => {
      expect(porterStem(word)).toBe(stem);
    });
  });

  describe("step 4 suffixes", () => {
    it.each([
      ["inference", "infer"],
      ["historic", "histor"],
      ["adjustable", "adjust"],
      ["possible", "possibl"],
      ["adoption", "adopt"],
      ["mechanism", "mechan"],
    ])("stems '%s' to '%s'", (word, stem) => {
      expect(porterStem(word)).toBe(stem);
    });
  });

  describe("trailing e and double consonant", () => {
    it.each([
      ["probate", "probat"],
      ["cease", "ceas"],
      ["controll", "control"],
    ])("stems '%s' to '%s'", (word, stem) => {
      expect(porterStem(word)).toBe(stem);
    });
  });

  describe("protected words", () => {
    it.each([
      ["grass", "grass"],
      ["feed", "feed"],
      ["singing", "sing"],
      ["sky", "sky"],
      ["rate", "rate"],
    ])("leaves '%s' as '%s'", (word, stem) => {
      expect(porterStem(word)).toBe(stem);
    });
  });

  describe("short words", () => {
    it.each([
      ["a", "a"],
      ["is", "is"],
    ])("leaves '%s' as '%s'", (word, stem) => {
      expect(porterStem(word)).toBe(stem);
    });
  });

  describe("case and non-letters", () => {
    it.each([
      ["Running", "Run"],
      ["RUNNING", "RUNNING"],
      ["well-known", "well-known"],
    ])("stems '%s' to '%s'", (word, stem) => {
      expect(porterStem(word)).toBe(stem);
    });
  });

  describe("inflections", () => {
    const families: Array<[string, string[]]> = [
      ["connect", ["connect", "connects", "connected", "connecting", "connection"]],
      ["collect", ["collect", "collects", "collected", "collecting", "collection"]],
      ["organ", ["organize", "organizes", "organized", "organizing", "organization"]],
      ["relat", ["relate", "relates", "related", "relating", "relation"]],
      ["activ", ["activate", "activates", "activated", "activating", "activation"]],
    ];

    it.each(families)("stems every inflection of a word to '%s'", (stem, words) => {
      expect(words.map(porterStem)).toEqual(words.map(() => stem));
    });

    it("keeps unrelated word families on distinct stems", () => {
      const stems = families.map(([, words]) => porterStem(words[0]));
      expect(stems).toEqual(["connect", "collect", "organ", "relat", "activ"]);
    });
  });
});
