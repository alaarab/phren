/**
 * Porter stemmer implementation for English words.
 * Based on the Porter (1980) algorithm.
 */
export function porterStem(word: string): string {
  if (word.length <= 2) return word;

  function isConsonant(w: string, i: number): boolean {
    const c = w[i];
    if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
    if (c === 'y') return i === 0 ? true : !isConsonant(w, i - 1);
    return true;
  }

  function measure(stem: string): number {
    if (stem.length === 0) return 0;
    let m = 0;
    let i = 0;
    // skip initial consonants
    while (i < stem.length && isConsonant(stem, i)) i++;
    while (i < stem.length) {
      // count vowel sequence
      while (i < stem.length && !isConsonant(stem, i)) i++;
      if (i >= stem.length) break;
      m++;
      // count consonant sequence
      while (i < stem.length && isConsonant(stem, i)) i++;
    }
    return m;
  }

  function hasVowel(stem: string): boolean {
    for (let i = 0; i < stem.length; i++) {
      if (!isConsonant(stem, i)) return true;
    }
    return false;
  }

  function endsDoubleConsonant(w: string): boolean {
    if (w.length < 2) return false;
    return w[w.length - 1] === w[w.length - 2] && isConsonant(w, w.length - 1);
  }

  function endsCVC(w: string): boolean {
    if (w.length < 3) return false;
    const l = w.length;
    if (!isConsonant(w, l - 1) || isConsonant(w, l - 2) || !isConsonant(w, l - 3)) return false;
    const last = w[l - 1];
    return last !== 'w' && last !== 'x' && last !== 'y';
  }

  function endsWith(w: string, suffix: string): string | null {
    if (w.length < suffix.length) return null;
    if (w.endsWith(suffix)) return w.slice(0, -suffix.length);
    return null;
  }

  let w = word;

  // Step 1a
  if (w.endsWith("sses")) {
    w = w.slice(0, -2);
  } else if (w.endsWith("ies")) {
    w = w.slice(0, -2);
  } else if (!w.endsWith("ss") && w.endsWith("s") && w.length > 2) {
    w = w.slice(0, -1);
  }

  // Step 1b
  let step1bExtra = false;
  if (w.endsWith("eed")) {
    const stem = w.slice(0, -3);
    if (measure(stem) > 0) w = w.slice(0, -1); // eed -> ee
  } else {
    let stemFound: string | null = null;
    if (w.endsWith("ed")) {
      stemFound = w.slice(0, -2);
    } else if (w.endsWith("ing")) {
      stemFound = w.slice(0, -3);
    }
    if (stemFound !== null && hasVowel(stemFound)) {
      w = stemFound;
      step1bExtra = true;
    }
  }

  if (step1bExtra) {
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) {
      w += "e";
    } else if (endsDoubleConsonant(w) && !w.endsWith("l") && !w.endsWith("s") && !w.endsWith("z")) {
      w = w.slice(0, -1);
    } else if (measure(w) === 1 && endsCVC(w)) {
      w += "e";
    }
  }

  // Step 1c
  if (w.endsWith("y") && w.length > 2 && hasVowel(w.slice(0, -1))) {
    w = w.slice(0, -1) + "i";
  }

  // Step 2
  const step2Map: Record<string, string> = {
    ational: "ate", tional: "tion", enci: "ence", anci: "ance",
    izer: "ize", abli: "able", alli: "al", entli: "ent", eli: "e",
    ousli: "ous", ization: "ize", ation: "ate", ator: "ate",
    alism: "al", iveness: "ive", fulness: "ful", ousness: "ous",
    aliti: "al", iviti: "ive", biliti: "ble",
  };
  for (const [suffix, replacement] of Object.entries(step2Map)) {
    const stem = endsWith(w, suffix);
    if (stem !== null && measure(stem) > 0) {
      w = stem + replacement;
      break;
    }
  }

  // Step 3
  const step3Map: Record<string, string> = {
    icate: "ic", ative: "", iciti: "ic",
    ical: "ic", ful: "", ness: "",
  };
  for (const [suffix, replacement] of Object.entries(step3Map)) {
    const stem = endsWith(w, suffix);
    if (stem !== null && measure(stem) > 0) {
      w = stem + replacement;
      break;
    }
  }

  // Step 4
  const step4Suffixes = [
    "al", "ance", "ence", "er", "ic", "able", "ible", "ant",
    "ement", "ment", "ent", "ion", "ou", "ism", "ate", "iti",
    "ous", "ive", "ize",
  ];
  for (const suffix of step4Suffixes) {
    const stem = endsWith(w, suffix);
    if (stem !== null && measure(stem) > 1) {
      if (suffix === "ion") {
        if (stem.endsWith("s") || stem.endsWith("t")) {
          w = stem;
        }
      } else {
        w = stem;
      }
      break;
    }
  }

  // Step 5a
  if (w.endsWith("e")) {
    const stem = w.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !endsCVC(stem))) {
      w = stem;
    }
  }

  // Step 5b
  if (measure(w) > 1 && endsDoubleConsonant(w) && w.endsWith("l")) {
    w = w.slice(0, -1);
  }

  return w;
}
