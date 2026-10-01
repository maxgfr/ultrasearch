import type { ModeProfile } from "../types.js";

// Coupons and discount codes for one merchant, in one country (--lang/--region).
// Leans on the deal communities (Pepper network, Reddit) and the web cascade;
// the `codes` extra turns whatever they say into ranked, UNVERIFIED candidates.
export const dealsMode: ModeProfile = {
  name: "deals",
  description:
    "Coupon & discount-code finder for a merchant — deal communities (Dealabs/hotukdeals/mydealz…), Reddit, the web; codes extracted, ranked, marked UNVERIFIED (+codes.json).",
  backends: ["pepper", "reddit", "duckduckgo", "searxng"],
  deepOnly: [],
  extras: ["codes"],
  // Ordered by yield: `queries` keeps the first 2 / 4 / 8 by depth.
  searchAngles: [
    "the merchant + 'promo code' in the country's language + this month and year (e.g. 'code promo decathlon octobre 2026')",
    "site: the country's Pepper deal community (dealabs.com, hotukdeals.com, mydealz.de, chollometro.com, pepper.pl, nl.pepper.com) + the merchant",
    "the country's coupon aggregators + the merchant (RetailMeNot, Ma-Reduc, Radins, Picodi, Sparwelt, Groupon…)",
    "site:reddit.com + the merchant + 'code', and the country's consumer forums",
    "the merchant's OWN offers: first-order / welcome discount, newsletter sign-up, app-only codes, loyalty programme",
    "influencer, podcast and YouTube sponsor codes for the merchant",
    "student, healthcare / key-worker, military and teacher discounts for the merchant",
    "cashback portals and card-linked offers for the merchant",
    "the merchant's referral (refer-a-friend) programme and discounted gift cards",
    "the merchant's sales calendar: seasonal sales, Black Friday, its own event days",
    "price matching, outlet, clearance and refurbished sections",
    "'<merchant> code not working' / 'expired' — what people report failing",
  ],
  template: [
    "## TL;DR",
    "## Candidate codes",
    "### Codes table (code · discount · conditions · expires · sources · confidence · tested)",
    "## Merchant's own offers",
    "## Other ways to save",
    "## Sales calendar",
    "## Expired, fake or unverifiable codes",
    "## Sources",
  ].join("\n"),
};
