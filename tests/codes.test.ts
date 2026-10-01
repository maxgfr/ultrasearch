import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateCodes,
  annotateCodes,
  cleanCode,
  codesSummary,
  extractCodes,
  merchantOf,
  writeCodes,
  type CodesFile,
  type ExtractOptions,
} from "../src/codes.js";
import type { CodeMention, Manifest, Source } from "../src/types.js";

const NOW = "2026-10-01T12:00:00.000Z";
const fr = { lang: "fr", region: "fr", now: NOW, merchant: "decathlon" };
const codesOf = (ms: { code: string }[]) => ms.map((m) => m.code);

describe("merchantOf", () => {
  it("takes the registrable name out of a domain", () => {
    expect(merchantOf("code promo decathlon.fr")).toBe("decathlon");
    expect(merchantOf("coupons https://www.amazon.co.uk/deals")).toBe("amazon");
  });
  it("strips the deal vocabulary, dates and glue words, keeping a multi-word name", () => {
    expect(merchantOf("Nike promo code")).toBe("nike");
    expect(merchantOf("code promo la redoute octobre 2026")).toBe("la redoute");
    expect(merchantOf("Gutscheincode für Zalando")).toBe("zalando");
  });
  it("returns undefined when nothing is left", () => {
    expect(merchantOf("")).toBeUndefined();
    expect(merchantOf("code promo")).toBeUndefined();
  });
});

describe("extractCodes — real codes", () => {
  it("FR: keyword + code, percent, minimum spend, dd/mm expiry", () => {
    const [m] = extractCodes("Profitez de 10% de réduction avec le code promo RENTREE10 dès 50€ d'achat, valable jusqu'au 31/10/2026.", fr);
    expect(m).toMatchObject({ code: "RENTREE10", via: "text", strength: "strong", discount: "10%", minSpend: "50 €", expires: "2026-10-31" });
  });

  it("EN (US): 'use code', minimum after the discount, mm/dd expiry", () => {
    const [m] = extractCodes("Use code SAVE20 for 20% off orders over $50. Expires 10/31/2026.", { lang: "en", region: "us", now: NOW });
    expect(m).toMatchObject({ code: "SAVE20", strength: "strong", discount: "20%", minSpend: "$50", expires: "2026-10-31" });
  });

  it("EN (GB): dd/mm is the default and mm/dd is refused outside the US", () => {
    const [gb] = extractCodes("Voucher code AUTUMN10 gives £10 off, valid until 15/11/2026.", { lang: "en", region: "gb", now: NOW });
    expect(gb).toMatchObject({ code: "AUTUMN10", discount: "£10", expires: "2026-11-15" });
    const [bad] = extractCodes("Voucher code AUTUMN10, valid until 11/15/2026.", { lang: "en", region: "gb", now: NOW });
    expect(bad!.expires).toBeUndefined();
  });

  it("DE: Gutscheincode, 'ab' minimum, dotted date", () => {
    const [m] = extractCodes("Mit dem Gutscheincode HERBST15 spart ihr 15% ab 60€ Mindestbestellwert, gültig bis 15.11.2026.", {
      lang: "de",
      region: "de",
      now: NOW,
    });
    expect(m).toMatchObject({ code: "HERBST15", discount: "15%", minSpend: "60 €", expires: "2026-11-15" });
  });

  it("ES: 'usa el código', month-name expiry", () => {
    const [m] = extractCodes("Usa el código VERANO20 y consigue un 20% de descuento hasta el 30 de noviembre de 2026.", {
      lang: "es",
      region: "es",
      now: NOW,
    });
    expect(m).toMatchObject({ code: "VERANO20", discount: "20%", expires: "2026-11-30" });
  });

  it("IT: codice sconto, amount discount, Italian month", () => {
    const [m] = extractCodes("Inserisci il codice sconto AUTUNNO10 per avere 10€ di sconto, valido fino al 31 dicembre 2026.", {
      lang: "it",
      region: "it",
      now: NOW,
    });
    expect(m).toMatchObject({ code: "AUTUNNO10", discount: "10 €", expires: "2026-12-31" });
  });

  it("free shipping is a discount; a year-less date takes the run's year", () => {
    const [m] = extractCodes("Code promo LIVRAISON0 : livraison gratuite jusqu'au 20 octobre.", fr);
    expect(m).toMatchObject({ code: "LIVRAISON0", discount: "free shipping", expires: "2026-10-20" });
  });

  it("weak: a quoted or bold token shortly after a keyword", () => {
    const ms = extractCodes('Our voucher this week — enter "AUTUMN15" at checkout. Another coupon: **WINTER5** too.', { lang: "en", now: NOW });
    expect(ms.find((m) => m.code === "AUTUMN15")).toMatchObject({ strength: "weak" });
    expect(codesOf(ms)).toContain("WINTER5");
  });

  it("accepts a lowercase code only when it carries a digit, and upper-cases it", () => {
    expect(codesOf(extractCodes("just use code save20 at checkout", { lang: "en", now: NOW }))).toEqual(["SAVE20"]);
    expect(codesOf(extractCodes("code promo valable sur tout le site", fr))).toEqual([]);
  });

  it("dedupes a code mentioned twice, keeping the strongest reading", () => {
    const ms = extractCodes('Coupon "BACK10" ici. Et le code promo BACK10 donne 10% de remise.', fr);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ code: "BACK10", strength: "strong", discount: "10%" });
  });
});

describe("extractCodes — decoys", () => {
  const none = (text: string, opts: ExtractOptions = fr) => expect(codesOf(extractCodes(text, opts)), text).toEqual([]);

  it("rejects the merchant's own name and the deal vocabulary", () => {
    none("CODE PROMO DECATHLON — le code promo OCTOBRE du mois");
    none("Coupon FREE SHIPPING and voucher SALE today", { lang: "en", region: "gb", now: NOW, merchant: "x" });
  });

  it("never takes a truncated code (live: 'appliquez le code promo \"IMAG...' on an aggregator)", () => {
    none('Pour en bénéficier, appliquez le code promo "IMAG...');
    none("Pour en bénéficier, appliquez le code promo IMAG… sur la page");
    expect(codesOf(extractCodes("Code promo IMAGE10. Valable sur tout le site.", fr))).toEqual(["IMAGE10"]);
  });

  it("reads a bare word after a code keyword as a brand, not a code (live false positive, fr.coupert.com)", () => {
    none("Découvrez comment utiliser les codes promo ASOS, étape par étape :");
    none("Voucher ARGOS and coupon AMAZON deals this week", { lang: "en", now: NOW });
    // …but a separator, quotes or an applying verb make the same shape a code.
    expect(codesOf(extractCodes("Utilisez le meilleur code de réduction 'FALL' pour 35% de remise.", fr))).toEqual(["FALL"]);
    expect(codesOf(extractCodes("Code promo : BIENVENUE pour votre première commande.", fr))).toEqual(["BIENVENUE"]);
    expect(codesOf(extractCodes("Just use code WELCOME at checkout.", { lang: "en", now: NOW }))).toEqual(["WELCOME"]);
    expect(codesOf(extractCodes("Commandez avec le code promo BIENVENUE.", fr))).toEqual(["BIENVENUE"]);
  });

  it("rejects years, percentages, SKUs/EANs and hashes", () => {
    none("code promo 2026 et code promo -20% sur tout");
    none("code promo REF1234567 sur la page produit");
    none("coupon 3F2A9C1B7D4E8F00 dans l'URL");
  });

  it("never reads a bare 'code' in a technical sense as a coupon", () => {
    none("Error code E404 occurred; the HTTP status code ABCD was logged.", { lang: "en", now: NOW });
  });

  it("rejects a product name repeated outside any keyword window", () => {
    const text = [
      "Le KIPRUN KS900 est une chaussure de running.",
      "Nous avons testé la KIPRUN sur 300 km.",
      "La gamme KIPRUN existe en trois largeurs.",
      "Code promo KIPRUN : aucun code n'existe en ce moment.",
    ].join("\n");
    none(text);
  });
});

describe("cleanCode", () => {
  it("accepts a structured voucher field only when it is shaped like a code", () => {
    expect(cleanCode(" app5 ")).toBe("APP5");
    expect(cleanCode("GAMING20")).toBe("GAMING20");
    expect(cleanCode("20% Coupon")).toBeUndefined();
    expect(cleanCode("indywidualny kod")).toBeUndefined();
    expect(cleanCode("")).toBeUndefined();
  });
});

describe("annotateCodes", () => {
  it("merges structured codes with text ones, and is idempotent", () => {
    const meta = { codes: [{ code: "APP5", via: "structured", strength: "strong", discount: "5 €" }] as CodeMention[] };
    const text = "Decathlon : avec le code promo APP5 dès 100€. Et le code promo RENTREE10 donne 10%.";
    const once = annotateCodes(text, meta, fr)!;
    expect(once.codes!.map((c) => [c.code, c.via])).toEqual([
      ["APP5", "structured"],
      ["RENTREE10", "text"],
    ]);
    expect(once.codes![0]!.minSpend).toBe("100 €"); // a text reading fills what the structured one lacked
    expect(annotateCodes(text, once, fr)).toEqual(once);
  });

  it("counts the page's title and url as naming the merchant (live: boulanger.com's own codes page)", () => {
    const body = "## CODES PROMO\n5% de remise immédiate\nBénéficiez de 5% de remise immédiate avec le code PACK5 dès 700€ d'achats\nPACK5\nCopier le code";
    const boulanger = { ...fr, merchant: "boulanger" };
    expect(annotateCodes(body, undefined, boulanger)).toBeUndefined();
    const got = annotateCodes(body, undefined, boulanger, "Code promo Boulanger https://www.boulanger.com/evenement/codes-promo");
    expect(got?.codes?.[0]).toMatchObject({ code: "PACK5", discount: "5%", minSpend: "700 €" });
  });

  it("takes no text code from a page that never names the merchant, but keeps structured ones", () => {
    const opera = "Seattle Opera responds by offering 14% off using the promo code ‘TIMOTHEE’.";
    expect(annotateCodes(opera, undefined, fr)).toBeUndefined();
    const meta = { codes: [{ code: "APP5", via: "structured", strength: "strong" }] as CodeMention[] };
    expect(annotateCodes(opera, meta, fr)).toBe(meta);
    // Accents, case and spacing do not hide the name.
    expect(annotateCodes("Chez La Redoute, le code promo AUTOMNE20 marche.", undefined, { ...fr, merchant: "la redoute" })?.codes?.[0]?.code).toBe("AUTOMNE20");
  });

  it("returns the meta untouched when the text holds no code", () => {
    const meta = { year: 2026 };
    expect(annotateCodes("rien à voir ici", meta, fr)).toBe(meta);
    expect(annotateCodes("rien à voir ici", undefined, fr)).toBeUndefined();
  });
});

function src(id: string, url: string, codes: CodeMention[]): Source {
  const domain = new URL(url).hostname.replace(/^www\./, "");
  return {
    id,
    url,
    canonicalUrl: url,
    title: id,
    backend: "duckduckgo",
    fetchedAt: NOW,
    domain,
    trust: 0.5,
    score: 1,
    extract: `sources/${id}.md`,
    snippet: "",
    meta: { codes },
  };
}
const text = (code: string, extra: Partial<CodeMention> = {}): CodeMention => ({ code, via: "text", strength: "strong", ...extra });

const manifest = { question: "code promo decathlon.fr", lang: "fr", region: "fr", builtAt: NOW } as Manifest;

describe("aggregateCodes", () => {
  it("counts corroboration by DISTINCT domain, not by page", () => {
    const { candidates } = aggregateCodes(
      [
        src("S1", "https://a.test/1", [text("ONE10")]),
        src("S2", "https://a.test/2", [text("ONE10")]),
        src("S3", "https://b.test/x", [text("TWO10")]),
        src("S4", "https://c.test/y", [text("TWO10")]),
      ],
      manifest,
    );
    const one = candidates.find((c) => c.code === "ONE10")!;
    const two = candidates.find((c) => c.code === "TWO10")!;
    expect(one).toMatchObject({ domains: 1, sources: ["S1", "S2"] });
    expect(two).toMatchObject({ domains: 2, sources: ["S3", "S4"] });
    expect(candidates[0]!.code).toBe("TWO10");
  });

  it("scores structured, corroborated, discounted, unexpired codes highest", () => {
    const { candidates } = aggregateCodes(
      [
        src("S1", "https://www.dealabs.com/t/1", [{ code: "APP5", via: "structured", strength: "strong", discount: "5 €", expires: "2026-10-21" }]),
        src("S2", "https://forum.test/p", [text("APP5")]),
        src("S3", "https://blog.test/p", [{ code: "MAYBE1", via: "text", strength: "weak" }]),
      ],
      manifest,
    );
    expect(candidates.map((c) => [c.code, c.confidence])).toEqual([
      ["APP5", "high"],
      ["MAYBE1", "low"],
    ]);
    // 3·structured + 2·min(domains,4) + strength + discount + future expiry
    expect(candidates[0]!.score).toBe(3 + 4 + 1 + 1 + 1);
  });

  it("files a code whose expiry is before the run, or that its source marks expired, as expired", () => {
    const { candidates, expired } = aggregateCodes(
      [
        src("S1", "https://a.test/1", [text("OLD10", { expires: "2026-09-29" })]),
        src("S2", "https://b.test/1", [text("GONE5", { expired: true })]),
        src("S3", "https://c.test/1", [text("LIVE10", { expires: "2026-10-01" })]),
      ],
      manifest,
    );
    expect(codesOf(expired).sort()).toEqual(["GONE5", "OLD10"]);
    expect(codesOf(candidates)).toEqual(["LIVE10"]); // expiring today still counts
  });

  it("is deterministic: input order never changes the output", () => {
    const list = [
      src("S1", "https://a.test/1", [text("BBB10")]),
      src("S2", "https://b.test/1", [text("AAA10")]),
      src("S3", "https://c.test/1", [text("CCC10", { discount: "10%" })]),
    ];
    const a = aggregateCodes(list, manifest);
    const b = aggregateCodes([...list].reverse(), manifest);
    expect(b).toEqual(a);
    expect(codesOf(a.candidates)).toEqual(["CCC10", "AAA10", "BBB10"]);
  });
});

describe("writeCodes", () => {
  it("writes codes.json and returns an UNVERIFIED block for DOSSIER.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-codes-"));
    try {
      const lines = writeCodes(dir, [src("S1", "https://a.test/1", [text("RENTREE10", { discount: "10%", minSpend: "50 €" })])], manifest);
      const file = JSON.parse(readFileSync(join(dir, "codes.json"), "utf8")) as CodesFile;
      expect(file).toMatchObject({ merchant: "decathlon", region: "fr", builtAt: NOW });
      expect(file.candidates[0]).toMatchObject({ code: "RENTREE10", sources: ["S1"] });
      const md = lines.join("\n");
      expect(md).toContain("UNVERIFIED");
      expect(md).toMatch(/never invent/i);
      expect(md).toContain("| `RENTREE10` | 10% | min. 50 € |");
      expect(md).toContain("[S1]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps the table at 15 rows and says how many more codes.json holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-codes-"));
    try {
      const many = Array.from({ length: 20 }, (_, i) => src(`S${i + 1}`, `https://d${i}.test/`, [text(`CODE${String(i).padStart(2, "0")}`)]));
      const md = writeCodes(dir, many, manifest).join("\n");
      expect(md.match(/^\| `CODE/gm)).toHaveLength(15);
      expect(md).toContain("5 more");
      expect(existsSync(join(dir, "codes.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says plainly when nothing was extracted (DOSSIER.md block)", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-codes-"));
    try {
      expect(writeCodes(dir, [], manifest).join("\n")).toMatch(/No candidate code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("codesSummary — the list the run hands back", () => {
  it("lists every code to try, best first, with its sources — and the expired ones by name", () => {
    const s = codesSummary(
      [
        src("S1", "https://www.dealabs.com/x", [{ code: "BIENVENUE", via: "structured", strength: "strong", discount: "10€", expires: "2026-12-31" }]),
        src("S2", "https://a.test/1", [text("PACK5", { discount: "5%", minSpend: "200 €" })]),
        src("S3", "https://b.test/1", [text("OLD10", { expires: "2026-01-01" })]),
      ],
      manifest,
    );
    expect(s.key).toBe("codes");
    expect(s.data).toEqual({
      to_try: [
        { code: "BIENVENUE", discount: "10€", expires: "2026-12-31", confidence: "high", sources: ["S1"] },
        { code: "PACK5", discount: "5%", min_spend: "200 €", confidence: "low", sources: ["S2"] },
      ],
      expired: ["OLD10"],
    });
    const out = s.lines.join("\n");
    expect(out).toContain("2 to try — UNVERIFIED");
    expect(out).toMatch(/BIENVENUE\s+10€\s+until 2026-12-31\s+high\s+\[S1\]/);
    expect(out).toMatch(/PACK5\s+5%\s+min\. 200 €\s+low\s+\[S2\]/);
    expect(out).toContain("expired: OLD10");
  });

  it("says so when nothing was extracted", () => {
    expect(codesSummary([], manifest).lines.join("\n")).toMatch(/codes:\s+none extracted/);
  });

  it("prints a table: every column starts at the same place on every row (live: Boulanger's list drifted)", () => {
    const rows = codesSummary(
      [
        src("S1", "https://www.boulanger.com/x", [text("PACK5", { discount: "5%", minSpend: "700 €", expires: "2026-12-31" })]),
        src("S2", "https://www.dealabs.com/y", [{ code: "BIENVENUE", via: "structured", strength: "strong", discount: "10€", expires: "2026-12-31" }]),
        src("S3", "https://c.test/z", [text("PROMO20")]),
      ],
      manifest,
    ).lines.slice(1);
    const at = (re: RegExp) => rows.map((r) => r.search(re));
    for (const col of [/\[S\d+\]/, /\b(high|medium|low)\b/]) expect(new Set(at(col)).size, String(col)).toBe(1);
    const until = at(/until /).filter((i) => i >= 0);
    expect(until).toHaveLength(2);
    expect(new Set(until).size).toBe(1);
  });
});
