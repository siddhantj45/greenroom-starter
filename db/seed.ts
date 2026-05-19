/**
 * Greenroom 24-month synthetic seed.
 *
 * Generates ~540 shows across 24 months at The Crescent, with realistic:
 *   - artist tiers (draw size distributions)
 *   - deal type mix (flat 25%, vs 50%, percentage_of_net 15%, door 5%, percentage_of_gross 5%)
 *   - bonus structures (~30% of vs / % of net deals; mix of gross thresholds, sellout bonuses,
 *     attendance thresholds, and tier ratchets — some duplicated in prose, some only in prose)
 *   - sell-through variance
 *   - comps per show (artist GL, label, press, venue staff, sponsor, promo)
 *   - expense breakdowns
 *   - past settlements with deal-aware math
 *   - settlement lifecycle stages (draft → submitted → in_review → signed/disputed → revised → finalized → paid)
 *   - recoup line items on ~30% of past settlements (some agreed, some disputed)
 *
 * Specific narrative shows are injected by hand:
 *   - The Coastal Spell / WME dispute (March 14, 2025) referenced in
 *     data/dispute-thread.md
 *
 * Run via: npm run db:seed
 */

import { db, client } from "./index";
import { eq } from "drizzle-orm";
import {
  users,
  venues,
  agencies,
  agents,
  artists,
  shows,
  deals,
  ticketSales,
  comps,
  expenses,
  settlements,
  type Bonus,
  type Recoup,
  type DealRecoup,
  type SettlementStage,
} from "./schema";

// -------- Deterministic RNG --------
function makeRng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(42);
const rnd = () => rng();
const rndInt = (min: number, max: number) =>
  Math.floor(rnd() * (max - min + 1)) + min;
const choose = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const weighted = <T>(items: { value: T; weight: number }[]): T => {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rnd() * total;
  for (const i of items) {
    r -= i.weight;
    if (r <= 0) return i.value;
  }
  return items[items.length - 1].value;
};

// -------- Constants --------
const VENUE_ID = "venue_crescent";
const VENUE_CAPACITY = 650;
const MARIANA_ID = "user_mariana";
const MARCUS_ID = "user_marcus";
// TODAY is dynamic — anchored on the moment the seed is run. This keeps the
// product feeling current no matter when the candidate clones the repo. The
// Coastal Spell dispute below is hardcoded to a fixed historical date (March 14, 2025)
// because the email thread references it specifically; that show stays
// well in the past regardless of when the seed is regenerated.
const TODAY = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
})();

interface ArtistDef {
  id: string;
  name: string;
  genre: string;
  tier: "A" | "B" | "C" | "D";
  recurrence: number;
}

const ARTIST_DEFS: ArtistDef[] = [
  { id: "art_pale_lake", name: "Pale Lake", genre: "indie rock", tier: "A", recurrence: 3 },
  { id: "art_coastal_spell", name: "Coastal Spell", genre: "shoegaze", tier: "A", recurrence: 2 },
  { id: "art_the_quiet_houses", name: "The Quiet Houses", genre: "indie rock", tier: "A", recurrence: 2 },
  { id: "art_orenda", name: "Orenda", genre: "art rock", tier: "A", recurrence: 2 },
  { id: "art_jenny_hardwick", name: "Jenny Hardwick", genre: "songwriter", tier: "A", recurrence: 2 },
  { id: "art_summer_bonanza", name: "Summer Bonanza", genre: "garage rock", tier: "A", recurrence: 2 },
  { id: "art_lemonglow", name: "Lemonglow", genre: "dream pop", tier: "A", recurrence: 1 },
  { id: "art_mariners_wake", name: "Mariner's Wake", genre: "folk rock", tier: "A", recurrence: 2 },
  { id: "art_nevada_sundown", name: "Nevada Sundown", genre: "americana", tier: "B", recurrence: 4 },
  { id: "art_courier", name: "Courier", genre: "alt country", tier: "B", recurrence: 3 },
  { id: "art_cold_comfort", name: "Cold Comfort", genre: "indie pop", tier: "B", recurrence: 3 },
  { id: "art_briar_road", name: "Briar Road", genre: "americana", tier: "B", recurrence: 2 },
  { id: "art_telegraph_avenue", name: "Telegraph Avenue", genre: "soul", tier: "B", recurrence: 3 },
  { id: "art_the_first_light", name: "The First Light", genre: "indie rock", tier: "B", recurrence: 2 },
  { id: "art_minor_holiday", name: "Minor Holiday", genre: "indie pop", tier: "B", recurrence: 3 },
  { id: "art_grand_central", name: "Grand Central", genre: "rock", tier: "B", recurrence: 2 },
  { id: "art_winter_circle", name: "Winter Circle", genre: "indie folk", tier: "B", recurrence: 2 },
  { id: "art_august_haze", name: "August Haze", genre: "psych rock", tier: "B", recurrence: 3 },
  { id: "art_milk_route", name: "Milk Route", genre: "indie rock", tier: "B", recurrence: 2 },
  { id: "art_drive_north", name: "Drive North", genre: "alt country", tier: "B", recurrence: 2 },
  { id: "art_rookie_dive", name: "Rookie Dive", genre: "indie pop", tier: "C", recurrence: 4 },
  { id: "art_hollow_branch", name: "Hollow Branch", genre: "post rock", tier: "C", recurrence: 3 },
  { id: "art_low_rooms", name: "Low Rooms", genre: "indie rock", tier: "C", recurrence: 4 },
  { id: "art_navarro", name: "Navarro", genre: "songwriter", tier: "C", recurrence: 3 },
  { id: "art_stoneflower", name: "Stoneflower", genre: "indie folk", tier: "C", recurrence: 3 },
  { id: "art_wax_paper", name: "Wax Paper", genre: "indie pop", tier: "C", recurrence: 3 },
  { id: "art_rivers_end", name: "Rivers End", genre: "americana", tier: "C", recurrence: 4 },
  { id: "art_blue_dial", name: "Blue Dial", genre: "indie rock", tier: "C", recurrence: 3 },
  { id: "art_gentle_riot", name: "Gentle Riot", genre: "garage rock", tier: "C", recurrence: 3 },
  { id: "art_park_avenue", name: "Park Avenue", genre: "indie pop", tier: "C", recurrence: 3 },
  { id: "art_ferns", name: "Ferns", genre: "ambient", tier: "C", recurrence: 2 },
  { id: "art_sunday_drivers", name: "Sunday Drivers", genre: "alt country", tier: "C", recurrence: 3 },
  { id: "art_post_hill", name: "Post Hill", genre: "indie rock", tier: "C", recurrence: 3 },
  { id: "art_lonesome_west", name: "Lonesome West", genre: "americana", tier: "C", recurrence: 2 },
  { id: "art_north_blue", name: "North Blue", genre: "indie folk", tier: "C", recurrence: 3 },
  { id: "art_overcoats", name: "Overcoats", genre: "indie pop", tier: "C", recurrence: 2 },
  { id: "art_radio_tower", name: "Radio Tower", genre: "indie rock", tier: "C", recurrence: 3 },
  { id: "art_low_country", name: "Low Country", genre: "americana", tier: "C", recurrence: 4 },
  { id: "art_wet_cement", name: "Wet Cement", genre: "garage rock", tier: "D", recurrence: 6 },
  { id: "art_red_letter", name: "Red Letter", genre: "indie rock", tier: "D", recurrence: 5 },
  { id: "art_evening_wear", name: "Evening Wear", genre: "indie pop", tier: "D", recurrence: 4 },
  { id: "art_simple_machines", name: "Simple Machines", genre: "punk", tier: "D", recurrence: 5 },
  { id: "art_two_lanes", name: "Two Lanes", genre: "alt country", tier: "D", recurrence: 4 },
  { id: "art_atlas_atlas", name: "Atlas Atlas", genre: "indie rock", tier: "D", recurrence: 3 },
  { id: "art_kerosene_kid", name: "Kerosene Kid", genre: "blues rock", tier: "D", recurrence: 4 },
  { id: "art_stay_dry", name: "Stay Dry", genre: "indie pop", tier: "D", recurrence: 3 },
  { id: "art_basement_window", name: "Basement Window", genre: "indie rock", tier: "D", recurrence: 4 },
  { id: "art_warm_milk", name: "Warm Milk", genre: "shoegaze", tier: "D", recurrence: 3 },
  { id: "art_dust_off", name: "Dust Off", genre: "garage rock", tier: "D", recurrence: 5 },
  { id: "art_pen_pal", name: "Pen Pal", genre: "indie pop", tier: "D", recurrence: 3 },
  { id: "art_safe_houses", name: "Safe Houses", genre: "indie rock", tier: "D", recurrence: 4 },
  { id: "art_lake_effect", name: "Lake Effect", genre: "ambient", tier: "D", recurrence: 3 },
  { id: "art_tin_signal", name: "Tin Signal", genre: "post rock", tier: "D", recurrence: 4 },
  { id: "art_hospital_corners", name: "Hospital Corners", genre: "punk", tier: "D", recurrence: 3 },
  { id: "art_glass_bottle", name: "Glass Bottle", genre: "indie folk", tier: "D", recurrence: 4 },
  { id: "art_freight_class", name: "Freight Class", genre: "rock", tier: "D", recurrence: 3 },
  { id: "art_ledger", name: "Ledger", genre: "indie pop", tier: "D", recurrence: 3 },
  { id: "art_deck_chairs", name: "Deck Chairs", genre: "americana", tier: "D", recurrence: 4 },
  { id: "art_house_of_lights", name: "House of Lights", genre: "indie rock", tier: "D", recurrence: 3 },
];

const AGENCIES = [
  { id: "agcy_wme", name: "WME" },
  { id: "agcy_caa", name: "CAA" },
  { id: "agcy_wasserman", name: "Wasserman" },
  { id: "agcy_paradigm", name: "Paradigm" },
  { id: "agcy_independent", name: "Independent" },
];

const AGENT_DEFS = [
  { id: "agent_sarah_kim", name: "Sarah Kim", agencyId: "agcy_wme", email: "skim@wme.com", preferencesNotes: "One of the easier WME agents. Reads settlements carefully but fairly. Pet peeve: 'Miscellaneous' line items in expenses without itemization." },
  { id: "agent_daniel_hwang", name: "Daniel Hwang", agencyId: "agcy_wme", email: "dhwang@wme.com", preferencesNotes: "Pushes back hard. Wrote the email thread on the Coastal Spell dispute (March 2025). Tends to ambiguity in deal emails — worth pre-negotiating clarifications." },
  { id: "agent_andrea_pelletier", name: "Andrea Pelletier", agencyId: "agcy_wme", email: "apelletier@wme.com", preferencesNotes: "Negotiates the deals; her colleagues handle settlement." },
  { id: "agent_danny_ortiz", name: "Danny Ortiz", agencyId: "agcy_caa", email: "dortiz@caa.com", preferencesNotes: "Easygoing. Trusts Mariana. Quick to sign off." },
  { id: "agent_meera_patel", name: "Meera Patel", agencyId: "agcy_caa", email: "mpatel@caa.com", preferencesNotes: "New at CAA, took over a roster from a departing agent. Still learning our venue." },
  { id: "agent_chris_lockhart", name: "Chris Lockhart", agencyId: "agcy_caa", email: "clockhart@caa.com", preferencesNotes: null },
  { id: "agent_pat_cho", name: "Pat Cho", agencyId: "agcy_independent", email: "pat@patcho.co", preferencesNotes: "Books smaller indie bands. Often the artist's manager too." },
  { id: "agent_rosa_jimenez", name: "Rosa Jimenez", agencyId: "agcy_wasserman", email: "rjimenez@wasserman.com", preferencesNotes: null },
  { id: "agent_tom_neary", name: "Tom Neary", agencyId: "agcy_wasserman", email: "tneary@wasserman.com", preferencesNotes: "Has his own settlement template he wants filled in. Annoying but he renews the relationship." },
  { id: "agent_kev_park", name: "Kev Park", agencyId: "agcy_paradigm", email: "kpark@paradigmagency.com", preferencesNotes: null },
  { id: "agent_naomi_brand", name: "Naomi Brand", agencyId: "agcy_paradigm", email: "nbrand@paradigmagency.com", preferencesNotes: null },
  { id: "agent_maya_okafor", name: "Maya Okafor", agencyId: "agcy_independent", email: "maya@mayaokafor.com", preferencesNotes: null },
  { id: "agent_jordan_wells", name: "Jordan Wells", agencyId: "agcy_independent", email: "jordan@wellstalent.com", preferencesNotes: null },
  { id: "agent_cass_burke", name: "Cass Burke", agencyId: "agcy_independent", email: "cass@burkebooking.com", preferencesNotes: null },
];

const TIER_AGENCY_WEIGHTS: Record<ArtistDef["tier"], { value: string; weight: number }[]> = {
  A: [
    { value: "agcy_wme", weight: 4 },
    { value: "agcy_caa", weight: 3 },
    { value: "agcy_wasserman", weight: 2 },
    { value: "agcy_paradigm", weight: 1 },
  ],
  B: [
    { value: "agcy_wme", weight: 2 },
    { value: "agcy_caa", weight: 3 },
    { value: "agcy_wasserman", weight: 3 },
    { value: "agcy_paradigm", weight: 2 },
    { value: "agcy_independent", weight: 1 },
  ],
  C: [
    { value: "agcy_caa", weight: 1 },
    { value: "agcy_wasserman", weight: 2 },
    { value: "agcy_paradigm", weight: 3 },
    { value: "agcy_independent", weight: 4 },
  ],
  D: [
    { value: "agcy_independent", weight: 8 },
    { value: "agcy_paradigm", weight: 1 },
  ],
};

function pickAgentForArtist(tier: ArtistDef["tier"]): string {
  const agencyId = weighted(TIER_AGENCY_WEIGHTS[tier]);
  const agentsAtAgency = AGENT_DEFS.filter((a) => a.agencyId === agencyId);
  return choose(agentsAtAgency).id;
}

interface GeneratedDeal {
  type: "flat" | "percentage_of_gross" | "percentage_of_net" | "vs" | "door";
  guaranteeAmount: number | null;
  percentage: number | null;
  percentageBasis: "gross" | "net" | null;
  expenseCap: number | null;
  hospitalityCap: number | null;
  bonuses: Bonus[] | null;
  // Whether bonusesJson contains structures that the deal_notes_freetext also
  // describes. When false, the prose mentions things the structured form is
  // missing — a deliberate part of the seam.
  bonusesAlsoInProse: boolean;
  notes: string;
}

function generateBonuses(tier: ArtistDef["tier"], baseGuarantee: number): Bonus[] | null {
  const has = rnd() < (tier === "A" ? 0.65 : tier === "B" ? 0.35 : tier === "C" ? 0.15 : 0.05);
  if (!has) return null;

  const bonusType = weighted<"gross_threshold" | "gross_double" | "sellout" | "attendance" | "tier_ratchet">([
    { value: "gross_threshold", weight: 5 },
    { value: "gross_double", weight: 2 },
    { value: "sellout", weight: 2 },
    { value: "attendance", weight: 1 },
    { value: "tier_ratchet", weight: 1 },
  ]);

  const out: Bonus[] = [];
  switch (bonusType) {
    case "gross_threshold": {
      const threshold = Math.round((baseGuarantee * 4) / 1000) * 1000;
      const amount = Math.round((baseGuarantee * 0.15) / 50) * 50;
      out.push({
        type: "gross_threshold",
        label: `+$${amount.toLocaleString()} if gross > $${threshold.toLocaleString()}`,
        threshold,
        amount,
        stacks: rnd() < 0.5,
      });
      break;
    }
    case "gross_double": {
      const t1 = Math.round((baseGuarantee * 4) / 1000) * 1000;
      const t2 = Math.round((baseGuarantee * 5.5) / 1000) * 1000;
      const a1 = Math.round((baseGuarantee * 0.15) / 50) * 50;
      const a2 = Math.round((baseGuarantee * 0.15) / 50) * 50;
      out.push({
        type: "gross_threshold",
        label: `+$${a1.toLocaleString()} if gross > $${t1.toLocaleString()}`,
        threshold: t1,
        amount: a1,
        stacks: true,
      });
      out.push({
        type: "gross_threshold",
        label: `+$${a2.toLocaleString()} if gross > $${t2.toLocaleString()}`,
        threshold: t2,
        amount: a2,
        stacks: true,
      });
      break;
    }
    case "sellout": {
      const amount = Math.round((baseGuarantee * 0.2) / 100) * 100;
      out.push({
        type: "sellout",
        label: `+$${amount.toLocaleString()} on sellout`,
        amount,
      });
      break;
    }
    case "attendance": {
      const threshold = Math.round(VENUE_CAPACITY * 0.9);
      const amount = Math.round((baseGuarantee * 0.18) / 50) * 50;
      out.push({
        type: "attendance_threshold",
        label: `+$${amount.toLocaleString()} if attendance > ${threshold}`,
        threshold,
        amount,
      });
      break;
    }
    case "tier_ratchet": {
      const breakpoint = Math.round((baseGuarantee * 4) / 1000) * 1000;
      out.push({
        type: "tier_ratchet",
        label: `Tiered net split: 60% / 70% over $${breakpoint.toLocaleString()}`,
        tiers: [
          { from: 0, to: breakpoint, percentage: 0.6 },
          { from: breakpoint, to: null, percentage: 0.7 },
        ],
      });
      break;
    }
  }
  return out;
}

function generateDeal(tier: ArtistDef["tier"]): GeneratedDeal {
  const dealType = weighted<GeneratedDeal["type"]>([
    { value: "flat", weight: tier === "D" ? 6 : tier === "C" ? 3 : 1.5 },
    { value: "vs", weight: tier === "A" ? 11 : tier === "B" ? 9 : tier === "C" ? 5 : 1 },
    { value: "percentage_of_net", weight: 3 },
    { value: "door", weight: tier === "D" ? 1 : 0.5 },
    { value: "percentage_of_gross", weight: 0.5 },
  ]);

  const baseGuarantee = {
    A: rndInt(4500, 9000),
    B: rndInt(2500, 5500),
    C: rndInt(1000, 2800),
    D: rndInt(400, 1500),
  }[tier];

  switch (dealType) {
    case "flat": {
      // Flat deals occasionally have a sellout bonus
      const bonuses =
        rnd() < 0.15
          ? ([
              {
                type: "sellout" as const,
                label: `+$${Math.round(baseGuarantee * 0.2 / 100) * 100} on sellout`,
                amount: Math.round((baseGuarantee * 0.2) / 100) * 100,
              },
            ] as Bonus[])
          : null;
      return {
        type: "flat",
        guaranteeAmount: baseGuarantee,
        percentage: null,
        percentageBasis: null,
        expenseCap: null,
        hospitalityCap: null,
        bonuses,
        bonusesAlsoInProse: bonuses !== null && rnd() < 0.6,
        notes: bonuses
          ? `Flat $${baseGuarantee.toLocaleString()} + $${(bonuses[0] as { amount: number }).amount} on sellout. ${choose(["No expenses.", "Buyout deal.", "Tour routing."])}`
          : rnd() < 0.5
            ? `Flat $${baseGuarantee.toLocaleString()}. No upside.`
            : `Flat guarantee $${baseGuarantee.toLocaleString()}. ${choose(["Weeknight slot.", "Tour routing fill, no expenses.", "Local/regional act.", "Buyout deal."])}`,
      };
    }
    case "vs": {
      // Variation 1: most common — guarantee vs % of net
      // Variation 2: walkout pot — guarantee vs % of net, +100% of gross above breakeven
      // Variation 3: ratchet — % escalates by sales tier
      // Variation 4: vs % of GROSS (rarer, simpler math, riskier for venue)
      const flavor = weighted([
        { value: "standard" as const, weight: 6 },
        { value: "walkout" as const, weight: 1.5 },
        { value: "ratchet" as const, weight: 1.5 },
        { value: "vs_gross" as const, weight: 1 },
      ]);

      const pct = choose([0.7, 0.75, 0.8, 0.85, 0.85, 0.85, 0.9]);
      const expenseCap = Math.round((baseGuarantee * 0.5) / 50) * 50;
      const hospitalityCap = choose([300, 400, 500, 600]);
      const basis = flavor === "vs_gross" ? "gross" : "net";

      let bonuses = generateBonuses(tier, baseGuarantee);

      // Walkout pot — adds an attendance threshold bonus on top
      if (flavor === "walkout") {
        const breakeven = Math.round((baseGuarantee * 1.2) / 100) * 100;
        const walkout: Bonus = {
          type: "gross_threshold",
          label: `Walkout pot: 100% of gross above $${breakeven.toLocaleString()}`,
          threshold: breakeven,
          amount: Math.round(baseGuarantee * 0.5),
          stacks: true,
        };
        bonuses = bonuses ? [...bonuses, walkout] : [walkout];
      }

      // Ratchet — adds a tier_ratchet bonus
      if (flavor === "ratchet") {
        const ratchet: Bonus = {
          type: "tier_ratchet",
          label: `Ratchet: ${(pct * 100).toFixed(0)}% to ${((pct + 0.1) * 100).toFixed(0)}% over 80% sold`,
          tiers: [
            { from: 0, to: 0.8, percentage: pct },
            { from: 0.8, to: null, percentage: pct + 0.1 },
          ],
        };
        bonuses = bonuses ? [...bonuses, ratchet] : [ratchet];
      }

      const bonusesAlsoInProse = bonuses !== null && rnd() < 0.7;
      const bonusesProseOnly = bonuses === null && rnd() < 0.2;

      return {
        type: "vs",
        guaranteeAmount: baseGuarantee,
        percentage: pct,
        percentageBasis: basis,
        expenseCap: flavor === "vs_gross" ? null : expenseCap,
        hospitalityCap,
        bonuses,
        bonusesAlsoInProse,
        notes: generateVsDealNotes(
          baseGuarantee,
          pct,
          expenseCap,
          hospitalityCap,
          bonusesAlsoInProse ? bonuses : null,
          bonusesProseOnly,
          flavor,
        ),
      };
    }
    case "percentage_of_net": {
      const pct = choose([0.8, 0.85, 0.85, 0.9]);
      const expenseCap = Math.round((baseGuarantee * 0.6) / 50) * 50;
      const bonuses = rnd() < 0.2 ? generateBonuses(tier, baseGuarantee) : null;
      return {
        type: "percentage_of_net",
        guaranteeAmount: null,
        percentage: pct,
        percentageBasis: "net",
        expenseCap,
        hospitalityCap: choose([300, 400, 500]),
        bonuses,
        bonusesAlsoInProse: bonuses !== null && rnd() < 0.6,
        notes: `${(pct * 100).toFixed(0)}% of net after expenses. Expenses capped $${expenseCap}. No guarantee.${
          bonuses ? ` ${bonuses[0].label}.` : ""
        }`,
      };
    }
    case "door": {
      const expenseCap = Math.round((baseGuarantee * 0.4) / 50) * 50;
      return {
        type: "door",
        guaranteeAmount: null,
        percentage: null,
        percentageBasis: null,
        expenseCap,
        hospitalityCap: choose([200, 300]),
        bonuses: null,
        bonusesAlsoInProse: false,
        notes: `Door deal. Artist gets ticket revenue minus expenses (capped $${expenseCap}). DIY/experimental tour.`,
      };
    }
    case "percentage_of_gross": {
      const pct = choose([0.7, 0.75, 0.8]);
      const bonuses =
        rnd() < 0.25
          ? ([
              {
                type: "sellout" as const,
                label: `+$${Math.round(baseGuarantee * 0.15 / 100) * 100} on sellout`,
                amount: Math.round((baseGuarantee * 0.15) / 100) * 100,
              },
            ] as Bonus[])
          : null;
      return {
        type: "percentage_of_gross",
        guaranteeAmount: null,
        percentage: pct,
        percentageBasis: "gross",
        expenseCap: null,
        hospitalityCap: null,
        bonuses,
        bonusesAlsoInProse: bonuses !== null && rnd() < 0.5,
        notes: `${(pct * 100).toFixed(0)}% of gross. No expense deductions. Simple split deal.${
          bonuses ? ` Sellout bonus per the email.` : ""
        }`,
      };
    }
  }
}

function generateVsDealNotes(
  guarantee: number,
  pct: number,
  expenseCap: number,
  hospitalityCap: number,
  bonuses: Bonus[] | null,
  bonusesProseOnly: boolean,
  flavor: "standard" | "walkout" | "ratchet" | "vs_gross" = "standard",
): string {
  const bonusProseSnippet = bonuses
    ? ` ${bonuses.map((b) => b.label).join("; ")}.`
    : bonusesProseOnly
      ? ` Performance bonuses per the deal memo (see email thread).`
      : "";

  if (flavor === "walkout") {
    return choose([
      () =>
        `$${guarantee.toLocaleString()} vs ${(pct * 100).toFixed(0)}% net + walkout pot. After breakeven on guarantee + expenses, all incremental gross goes to artist. Hospitality cap $${hospitalityCap}.${bonusProseSnippet}`,
      () =>
        `${guarantee.toLocaleString()} g'tee vs ${(pct * 100).toFixed(0)}/${((1 - pct) * 100).toFixed(0)} net, walkout above breakeven. Expense cap ${expenseCap}, hosp $${hospitalityCap}.${bonusProseSnippet}`,
    ])();
  }

  if (flavor === "ratchet") {
    const upper = ((pct + 0.1) * 100).toFixed(0);
    return choose([
      () =>
        `$${guarantee.toLocaleString()} vs ${(pct * 100).toFixed(0)}% net to 80% sold, ${upper}% above. Expense cap $${expenseCap}, hospitality $${hospitalityCap}.${bonusProseSnippet}`,
      () =>
        `${guarantee.toLocaleString()} g'tee with escalator: ${(pct * 100).toFixed(0)}% net at base, ratchets to ${upper}% over 80% capacity. Expenses to ${expenseCap}.${bonusProseSnippet}`,
    ])();
  }

  if (flavor === "vs_gross") {
    return choose([
      () =>
        `$${guarantee.toLocaleString()} vs ${(pct * 100).toFixed(0)}% of GROSS (no expense deductions), whichever greater. Hospitality cap $${hospitalityCap}.${bonusProseSnippet}`,
      () =>
        `${guarantee.toLocaleString()} g'tee vs ${(pct * 100).toFixed(0)}% gross — no expenses come out. Simpler math, riskier for venue. Hosp $${hospitalityCap}.${bonusProseSnippet}`,
    ])();
  }

  // Standard
  const variants = [
    () =>
      `$${guarantee.toLocaleString()} guarantee vs ${(pct * 100).toFixed(0)}% of net after expenses, whichever greater. Expenses capped $${expenseCap}. Hospitality cap $${hospitalityCap}.${bonusProseSnippet}`,
    () =>
      `Deal: $${guarantee.toLocaleString()} vs ${(pct * 100).toFixed(0)}/${((1 - pct) * 100).toFixed(0)} after expenses. Expense cap ${expenseCap}, hospitality cap ${hospitalityCap}.${bonusProseSnippet}`,
    () =>
      `${guarantee.toLocaleString()} g'tee vs ${(pct * 100).toFixed(0)}% of net. Expenses to ${expenseCap}. Hospitality $${hospitalityCap}.${bonusProseSnippet}`,
  ];
  return choose(variants)();
}

function generateSellThrough(tier: ArtistDef["tier"]): number {
  const base = { A: 0.85, B: 0.65, C: 0.45, D: 0.25 }[tier];
  const variance = (rnd() - 0.5) * 0.4;
  return Math.max(0.05, Math.min(1.0, base + variance));
}

// -------- Comps generation --------

function generateComps(showId: string, tier: ArtistDef["tier"], avgPrice: number) {
  type CompRow = typeof comps.$inferInsert;
  const result: CompRow[] = [];
  let i = 0;
  const add = (
    category: CompRow["category"],
    count: number,
    countsTowardGross = false,
    notes: string | null = null,
  ) => {
    if (count === 0) return;
    result.push({
      id: `comp_${showId}_${i++}`,
      showId,
      category,
      count,
      faceValue: avgPrice,
      countsTowardGross,
      notes,
    });
  };

  // Artist guest list — scales with tier draw
  const glCount = { A: rndInt(15, 28), B: rndInt(10, 20), C: rndInt(6, 14), D: rndInt(3, 10) }[tier];
  add("artist_gl", glCount);

  // Label / management — only for bigger acts, mostly
  if (tier === "A" || tier === "B") {
    add("label", rndInt(2, 8));
  } else if (rnd() < 0.3) {
    add("label", rndInt(1, 3));
  }

  // Press
  if (tier !== "D" || rnd() < 0.4) {
    add("press", rndInt(2, 5));
  }

  // Venue staff
  add("venue_staff", rndInt(3, 8));

  // Sponsor (rare)
  if (rnd() < 0.15) add("sponsor", rndInt(2, 5));

  // Promo (radio giveaways, 2-for-1s, etc.)
  if (rnd() < 0.25) {
    add(
      "promo",
      rndInt(4, 12),
      rnd() < 0.3, // sometimes promo comps DO count toward gross at face
      choose(["Radio giveaway", "2-for-1 Tuesday promo", "Spotify pre-save campaign"]),
    );
  }

  return result;
}

function generateExpenses(showId: string) {
  type ExpenseRow = typeof expenses.$inferInsert;
  const result: ExpenseRow[] = [];
  let i = 0;
  const add = (
    category: ExpenseRow["category"],
    amount: number,
    description: string | null = null,
    absorbed = false,
  ) => {
    result.push({
      id: `exp_${showId}_${i++}`,
      showId,
      category,
      amount: Math.round(amount * 100) / 100,
      description,
      approved: true,
      absorbedByVenue: absorbed,
      enteredByUserId: MARIANA_ID,
      enteredAt: new Date(),
    });
  };

  add("sound", rndInt(280, 450));
  add("lights", rndInt(150, 250));
  add("production", rndInt(180, 350));
  add("hospitality", rndInt(180, 480));
  if (rnd() < 0.7) add("marketing", rndInt(150, 600), choose(["Spotify ad", "Instagram boost", "Local radio spot"]));
  if (rnd() < 0.4) add("backline", rndInt(120, 280), "Backline rental");
  if (rnd() < 0.3) add("security", rndInt(80, 200));
  if (rnd() < 0.15) add("hospitality", rndInt(50, 120), "Hospitality overage", true);
  return result;
}

// -------- Recoups generation --------

function generateRecoups(
  showId: string,
  marketingExpense: number,
  hospitalityCap: number | null,
  hospitalityTotal: number,
): Recoup[] | null {
  // ~30% of past settlements have at least one recoup line item
  if (rnd() > 0.3) return null;

  const result: Recoup[] = [];
  let id = 0;

  // Marketing recoup — when there's marketing spend
  if (marketingExpense > 200 && rnd() < 0.5) {
    const amount = Math.round(marketingExpense * (0.5 + rnd() * 0.5));
    result.push({
      id: `recoup_${showId}_${id++}`,
      category: "marketing",
      label: choose(["Co-op marketing spend", "Pre-show ad spend", "Spotify ad recoup"]),
      amount,
      status: rnd() < 0.85 ? "agreed" : "disputed",
    });
  }

  // Hospitality overage — when hospitality exceeded the cap
  if (hospitalityCap != null && hospitalityTotal > hospitalityCap && rnd() < 0.7) {
    const overage = Math.round(hospitalityTotal - hospitalityCap);
    if (overage >= 50) {
      result.push({
        id: `recoup_${showId}_${id++}`,
        category: "hospitality_overage",
        label: `Over $${hospitalityCap} hospitality cap`,
        amount: overage,
        status: rnd() < 0.7 ? "agreed" : "disputed",
      });
    }
  }

  // Production overage (rarer)
  if (rnd() < 0.15) {
    result.push({
      id: `recoup_${showId}_${id++}`,
      category: "production_overage",
      label: choose(["Sound: extra mic pkg added", "Lights: programmer add'l night", "Backline: drum riser"]),
      amount: rndInt(100, 400),
      status: rnd() < 0.6 ? "agreed" : "disputed",
    });
  }

  // Prior advance (very rare)
  if (rnd() < 0.05) {
    result.push({
      id: `recoup_${showId}_${id++}`,
      category: "prior_advance",
      label: "Tour advance, March",
      amount: rndInt(500, 2000),
      status: "agreed",
    });
  }

  return result.length > 0 ? result : null;
}

// -------- Settlement lifecycle --------

function pickSettlementStage(daysAgo: number): SettlementStage {
  // The older the show, the more likely it's fully paid
  if (daysAgo > 60) {
    return weighted<SettlementStage>([
      { value: "paid", weight: 90 },
      { value: "finalized", weight: 4 },
      { value: "disputed", weight: 4 }, // long-running disputes
      { value: "voided", weight: 2 },
    ]);
  }
  if (daysAgo > 21) {
    return weighted<SettlementStage>([
      { value: "paid", weight: 60 },
      { value: "finalized", weight: 20 },
      { value: "signed", weight: 12 },
      { value: "disputed", weight: 6 },
      { value: "revised", weight: 2 },
    ]);
  }
  if (daysAgo > 7) {
    return weighted<SettlementStage>([
      { value: "paid", weight: 25 },
      { value: "finalized", weight: 25 },
      { value: "signed", weight: 30 },
      { value: "in_review", weight: 10 },
      { value: "disputed", weight: 8 },
      { value: "revised", weight: 2 },
    ]);
  }
  if (daysAgo > 2) {
    return weighted<SettlementStage>([
      { value: "signed", weight: 25 },
      { value: "in_review", weight: 30 },
      { value: "submitted", weight: 25 },
      { value: "disputed", weight: 8 },
      { value: "revised", weight: 4 },
      { value: "draft", weight: 8 },
    ]);
  }
  return weighted<SettlementStage>([
    { value: "draft", weight: 50 },
    { value: "submitted", weight: 30 },
    { value: "in_review", weight: 15 },
    { value: "signed", weight: 5 },
  ]);
}

function settlementTimestamps(stage: SettlementStage, showDate: Date) {
  // Show happened on showDate. Settlement starts as draft same night,
  // submitted next morning, reviewed within a day, signed within 2-3 days,
  // paid within 5-7 days. Disputes extend the timeline.
  const ts: Partial<Record<
    | "draftedAt"
    | "submittedAt"
    | "reviewStartedAt"
    | "signedAt"
    | "disputedAt"
    | "revisedAt"
    | "finalizedAt"
    | "paidAt",
    Date
  >> = {};
  const addHours = (base: Date, hrs: number) => {
    const d = new Date(base);
    d.setHours(d.getHours() + hrs);
    return d;
  };

  // Always have draftedAt
  ts.draftedAt = addHours(showDate, 5); // ~2am after the show

  const orderedStages: SettlementStage[] = [
    "draft",
    "submitted",
    "in_review",
    "signed",
    "disputed",
    "revised",
    "finalized",
    "paid",
  ];

  const stageIndex = orderedStages.indexOf(stage);
  if (stageIndex === -1) return ts; // voided — only draftedAt

  if (stageIndex >= 1) ts.submittedAt = addHours(showDate, 18);
  if (stageIndex >= 2) ts.reviewStartedAt = addHours(showDate, 30);
  if (stage === "signed" || (stageIndex >= 3 && stage !== "disputed")) {
    ts.signedAt = addHours(showDate, 60);
  }
  // Disputed path: set disputedAt for any settlement that went through dispute.
  // Some "paid" and "finalized" settlements went through dispute; some didn't.
  if (stage === "disputed" || stage === "revised") {
    ts.disputedAt = addHours(showDate, 48);
  }
  if (stage === "revised" || stage === "finalized" || stage === "paid") {
    ts.revisedAt = addHours(showDate, 72);
    ts.finalizedAt = addHours(showDate, 96);
  }
  if (stage === "paid") {
    ts.paidAt = addHours(showDate, 24 * 7);
  }
  return ts;
}

function computeSettlement(
  deal: GeneratedDeal,
  gross: number,
  fees: number,
  passThruExpenses: number,
): number {
  const net = gross - fees;
  switch (deal.type) {
    case "flat":
      return deal.guaranteeAmount ?? 0;
    case "percentage_of_gross":
      return gross * (deal.percentage ?? 0);
    case "percentage_of_net": {
      const cappedExpenses = Math.min(passThruExpenses, deal.expenseCap ?? Infinity);
      return Math.max(0, (net - cappedExpenses) * (deal.percentage ?? 0));
    }
    case "vs": {
      const cappedExpenses = Math.min(passThruExpenses, deal.expenseCap ?? Infinity);
      const netAfterExpenses = Math.max(0, net - cappedExpenses);
      const pctPayout = netAfterExpenses * (deal.percentage ?? 0);
      const guarantee = deal.guaranteeAmount ?? 0;
      const base = Math.max(guarantee, pctPayout);
      // Apply gross-threshold bonuses
      const bonusPayout =
        deal.bonuses
          ?.filter((b) => b.type === "gross_threshold")
          .filter((b) => gross >= b.threshold)
          .reduce((s, b) => s + b.amount, 0) ?? 0;
      const overrideGuarantee = pctPayout >= guarantee;
      return base + (overrideGuarantee ? bonusPayout : 0);
    }
    case "door": {
      const cappedExpenses = Math.min(passThruExpenses, deal.expenseCap ?? Infinity);
      return Math.max(0, gross - cappedExpenses);
    }
  }
}

function dateOffset(days: number): string {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log("🌱 Seeding 18-month Greenroom dataset…");

  await db.delete(settlements);
  await db.delete(expenses);
  await db.delete(comps);
  await db.delete(ticketSales);
  await db.delete(deals);
  await db.delete(shows);
  await db.delete(artists);
  await db.delete(agents);
  await db.delete(agencies);
  await db.delete(users);
  await db.delete(venues);

  await db.insert(venues).values({ id: VENUE_ID, name: "The Crescent", capacity: VENUE_CAPACITY, city: "Nashville", state: "TN" });
  await db.insert(users).values([
    { id: MARIANA_ID, name: "Mariana Reyes", email: "mariana@thecrescentnashville.com", role: "booker", venueId: VENUE_ID },
    { id: MARCUS_ID, name: "Marcus Holland", email: "marcus@thecrescentnashville.com", role: "gm", venueId: VENUE_ID },
  ]);
  await db.insert(agencies).values(AGENCIES);
  await db.insert(agents).values(AGENT_DEFS);

  const artistAgentMap = new Map<string, string>();
  for (const a of ARTIST_DEFS) artistAgentMap.set(a.id, pickAgentForArtist(a.tier));

  await db.insert(artists).values(
    ARTIST_DEFS.map((a) => ({
      id: a.id,
      name: a.name,
      agentId: artistAgentMap.get(a.id) ?? null,
      genre: a.genre,
      priorShowCount: rndInt(0, a.recurrence + 2),
    })),
  );

  // Build show calendar
  const showsToInsert: (typeof shows.$inferInsert)[] = [];
  const dealsToInsert: (typeof deals.$inferInsert)[] = [];
  const ticketSalesToInsert: (typeof ticketSales.$inferInsert)[] = [];
  const compsToInsert: (typeof comps.$inferInsert)[] = [];
  const expensesToInsert: (typeof expenses.$inferInsert)[] = [];
  const settlementsToInsert: (typeof settlements.$inferInsert)[] = [];

  // Track post-insert mutations for breadcrumbs that need to update artist
  // rows (already inserted earlier in main()).
  const breadcrumbsToFinalize: { kind: "artist_priorshows"; artistId: string }[] = [];

  const datePool: string[] = [];
  // 24 months back, 60 days forward. More density on weekends, but Sun/Mon
  // shows happen often enough that they should appear in the calendar.
  for (let off = -730; off <= 60; off++) {
    const d = new Date(TODAY);
    d.setDate(d.getDate() + off);
    const dow = d.getDay();
    // Sun/Mon less common but not rare
    if ((dow === 0 || dow === 1) && rnd() > 0.4) continue;
    // Tuesday slightly less common
    if (dow === 2 && rnd() > 0.7) continue;
    datePool.push(dateOffset(off));
  }
  // Shuffle so shows distribute across the full window — otherwise the
  // earliest dates fill up first and the recent weeks have no shows.
  for (let i = datePool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [datePool[i], datePool[j]] = [datePool[j], datePool[i]];
  }

  const artistPool: ArtistDef[] = [];
  for (const a of ARTIST_DEFS) {
    // Bumped multiplier so we have more shows per artist over the 24-month
    // window. Tier-A acts come back several times; D-tier are mostly one-offs.
    const count = Math.max(2, Math.round(a.recurrence * 3 + (rnd() - 0.5) * 2));
    for (let i = 0; i < count; i++) artistPool.push(a);
  }
  for (let i = artistPool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [artistPool[i], artistPool[j]] = [artistPool[j], artistPool[i]];
  }

  const showCount = Math.min(datePool.length, artistPool.length);
  for (let i = 0; i < showCount; i++) {
    const date = datePool[i];
    const artist = artistPool[i];
    const showId = `show_${i.toString().padStart(4, "0")}`;
    const showDate = new Date(date);
    const isPast = showDate < TODAY;
    const daysAgo = Math.floor((TODAY.getTime() - showDate.getTime()) / (1000 * 60 * 60 * 24));

    const avgPrice = artist.tier === "A" ? 32 : artist.tier === "B" ? 26 : artist.tier === "C" ? 20 : 15;

    showsToInsert.push({
      id: showId,
      venueId: VENUE_ID,
      artistId: artist.id,
      date,
      status: isPast ? "settled" : (rnd() < 0.6 ? "booked" : "advanced"),
      doorsTime: choose(["19:00", "19:30", "20:00"]),
      setTime: choose(["20:30", "21:00", "21:30"]),
      roomConfig: weighted([
        { value: "standing" as const, weight: 8 },
        { value: "seated" as const, weight: 1 },
        { value: "mixed" as const, weight: 1 },
      ]),
      createdAt: new Date(date),
    });

    const deal = generateDeal(artist.tier);
    dealsToInsert.push({
      id: `deal_${showId}`,
      showId,
      dealType: deal.type,
      guaranteeAmount: deal.guaranteeAmount,
      percentage: deal.percentage,
      percentageBasis: deal.percentageBasis,
      expenseCap: deal.expenseCap,
      hospitalityCap: deal.hospitalityCap,
      bonusesJson: deal.bonuses ? JSON.stringify(deal.bonuses) : null,
      dealNotesFreetext: deal.notes,
      createdAt: new Date(date),
    });

    // Comps for every show (past or upcoming)
    compsToInsert.push(...generateComps(showId, artist.tier, avgPrice));

    // Generate full financial data for ALL shows — past and future.
    // The query layer time-gates future shows so settlement/ticket data
    // only surfaces once the show date has passed. This way candidates
    // opening the case on any future date see complete data for shows
    // that have moved into the past.
    {
      const sellThrough = generateSellThrough(artist.tier);
      const ticketCount = Math.round(VENUE_CAPACITY * sellThrough);
      const gross = Math.round(ticketCount * avgPrice * (0.9 + rnd() * 0.2));
      const fees = Math.round(gross * 0.1);

      ticketSalesToInsert.push({
        id: `ts_${showId}`,
        showId,
        qty: ticketCount,
        gross,
        fees,
        capturedAt: new Date(date),
      });

      const showExpenses = generateExpenses(showId);
      expensesToInsert.push(...showExpenses);

      const passThru = showExpenses.filter((e) => !e.absorbedByVenue).reduce((s, e) => s + e.amount, 0);
      const totalToArtist = computeSettlement(deal, gross, fees, passThru);

      const effectiveDaysAgo = isPast ? daysAgo : rndInt(3, 30);
      const stage = isPast ? pickSettlementStage(daysAgo) : pickSettlementStage(effectiveDaysAgo);
      const ts = settlementTimestamps(stage, showDate);

      // Recoups for ~30% of settlements
      const marketingExpense = showExpenses
        .filter((e) => e.category === "marketing" && !e.absorbedByVenue)
        .reduce((s, e) => s + e.amount, 0);
      const hospitalityTotal = showExpenses
        .filter((e) => e.category === "hospitality")
        .reduce((s, e) => s + e.amount, 0);
      const recoups = generateRecoups(
        showId,
        marketingExpense,
        deal.hospitalityCap,
        hospitalityTotal,
      );

      settlementsToInsert.push({
        id: `stl_${showId}`,
        showId,
        status: stage,
        draftedAt: ts.draftedAt,
        submittedAt: ts.submittedAt,
        reviewStartedAt: ts.reviewStartedAt,
        signedAt: ts.signedAt,
        disputedAt: ts.disputedAt,
        revisedAt: ts.revisedAt,
        finalizedAt: ts.finalizedAt,
        paidAt: ts.paidAt,
        completedAt: ts.paidAt ?? ts.finalizedAt ?? ts.signedAt ?? new Date(date),
        completedByUserId: MARIANA_ID,
        grossBoxOffice: gross,
        netBoxOffice: gross - fees,
        totalExpenses: passThru,
        totalToArtist: Math.round(totalToArtist * 100) / 100,
        recoupsJson: recoups ? JSON.stringify(recoups) : null,
        signoffText:
          stage === "draft" || stage === "submitted" || stage === "in_review"
            ? null
            : choose(["OK. Good night.", "Looks good.", "👍", "ok wire monday", "Sign off."]),
        notes: rnd() < 0.1
          ? choose(["Hospitality $87 absorbed — over rider.", "Backline charge waived.", "Marketing recoup pre-deducted from gross.", "Comp tickets: 12. Revenue impact accepted."])
          : null,
      });
    }
  }

  // -------- Plant breadcrumbs: deliberate UI/data contradictions --------
  //
  // These are intentional inconsistencies that a sharp candidate should find
  // by reading the data carefully against what the UI displays. Each one
  // illuminates a different facet of why structured-fields-vs-prose is hard.
  // The hiring team's "answer key" lists what each breadcrumb tests for.
  //
  // We mutate already-generated rows rather than creating dedicated breadcrumb
  // shows — this way the IDs look ordinary and candidates have to mine.

  const pastSettlements = settlementsToInsert.filter(
    (s) => s.status !== "draft" && s.status !== "voided",
  );
  // Helpers
  const findShow = (id: string) => showsToInsert.find((s) => s.id === id);
  const findDeal = (showId: string) =>
    dealsToInsert.find((d) => d.showId === showId);
  const findSettlement = (showId: string) =>
    settlementsToInsert.find((s) => s.showId === showId);
  const findComps = (showId: string) =>
    compsToInsert.filter((c) => c.showId === showId);
  const findExpenses = (showId: string) =>
    expensesToInsert.filter((e) => e.showId === showId);

  // Pick deterministic targets — we use offsets into the pastSettlements list
  // so the same shows get planted on every reseed.
  const tgt = (offset: number) => {
    const i = (offset * 13 + 7) % pastSettlements.length;
    return pastSettlements[i].showId as string;
  };

  // BC1: Disputed status but positive signoff text — UI red flag, data agreement
  {
    const showId = tgt(0);
    const stl = findSettlement(showId);
    if (stl) {
      stl.status = "disputed";
      stl.disputedAt = stl.signedAt ?? stl.submittedAt;
      stl.signoffText =
        "Looks good — TM. Wire to the usual account when ready.";
      stl.notes =
        "[Mariana, internal] TM signed off Sunday morning. His assistant emailed Monday questioning the production-overage line — that's why this is showing as disputed. Need to either re-send a clean version or close the dispute. Haven't gotten back to it.";
    }
  }

  // BC2: Bonus threshold drift — prose says one number, bonuses_json says another
  {
    const targetDeal = dealsToInsert.find(
      (d) =>
        d.dealType === "vs" &&
        d.bonusesJson &&
        JSON.parse(d.bonusesJson)[0]?.type === "gross_threshold",
    );
    if (targetDeal) {
      const bonuses = JSON.parse(targetDeal.bonusesJson as string) as Bonus[];
      const orig = bonuses[0] as { threshold: number; amount: number };
      // Prose mentions a threshold $5k LOWER than what's in the structured field.
      // The deal was renegotiated by phone; only the prose got updated.
      const proseThreshold = orig.threshold - 5000;
      targetDeal.dealNotesFreetext =
        `${targetDeal.dealNotesFreetext} ` +
        `[Updated 4 days before show via phone call with agent: bonus threshold dropped to $${proseThreshold.toLocaleString()}. ` +
        `Note: structured field still reflects original $${orig.threshold.toLocaleString()} — confirm before settlement.]`;
    }
  }

  // BC3: Paid settlement with a still-disputed recoup
  {
    const target = pastSettlements.find(
      (s) => s.status === "paid" && !s.recoupsJson,
    );
    if (target) {
      target.recoupsJson = JSON.stringify([
        {
          id: `recoup_${target.showId}_late`,
          category: "marketing",
          label: "Late-add: pre-show Instagram boost ($340)",
          amount: 340,
          status: "disputed",
          insideExpenseCap: false,
        },
      ] as Recoup[]);
      target.notes =
        "Paid out per the agreed line items. TM emailed two weeks later flagging the IG boost recoup — never resolved, never re-issued. Carrying as outstanding.";
    }
  }

  // BC4: Recoup miscoded — labeled marketing, filed under production category
  {
    const target = pastSettlements.find(
      (s) => s.recoupsJson && JSON.parse(s.recoupsJson).length === 1,
    );
    if (target) {
      const recoups = JSON.parse(target.recoupsJson as string) as Recoup[];
      recoups.push({
        id: `recoup_${target.showId}_misfiled`,
        category: "production_overage", // wrong! it's marketing — but filed here
        label: "Spotify pre-show ad spend recoup",
        amount: 285,
        status: "agreed",
      });
      target.recoupsJson = JSON.stringify(recoups);
    }
  }

  // BC5: Hospitality silent overrun — cap was set, actuals blew through it,
  //      no expenses flagged as absorbed
  {
    const targetDeal = dealsToInsert.find(
      (d) => d.dealType === "vs" && d.hospitalityCap === 400,
    );
    if (targetDeal) {
      const expenses = findExpenses(targetDeal.showId);
      const hosp = expenses.find((e) => e.category === "hospitality");
      if (hosp) {
        hosp.amount = 620; // way over the $400 cap
        hosp.absorbedByVenue = false; // and nothing was absorbed
        hosp.description = "Whiskey, food run, post-show snacks";
      }
    }
  }

  // BC6: Percentage drift — prose says 85%, structured says 75%
  {
    const targetDeal = dealsToInsert.find(
      (d) =>
        (d.dealType === "vs" || d.dealType === "percentage_of_net") &&
        d.percentage === 0.75,
    );
    if (targetDeal) {
      // Prose was updated to reflect renegotiation; structured field never updated
      targetDeal.dealNotesFreetext =
        `Renegotiated 1 week before show: $${targetDeal.guaranteeAmount?.toLocaleString() ?? "—"} g'tee vs 85/15 split on net (was 75/25). ` +
        `Expense cap $${targetDeal.expenseCap}, hospitality $${targetDeal.hospitalityCap}.`;
    }
  }

  // BC7: Reversed timestamps — signedAt before submittedAt
  {
    const target = pastSettlements.find(
      (s) =>
        s.status === "paid" &&
        s.submittedAt &&
        s.signedAt &&
        s.submittedAt instanceof Date &&
        s.signedAt instanceof Date,
    );
    if (target) {
      // Swap them so signedAt < submittedAt
      const tmp = target.submittedAt;
      target.submittedAt = target.signedAt;
      target.signedAt = tmp;
    }
  }

  // BC8: Duplicate expense — same vendor, same amount, ~3 hours apart
  {
    const target = pastSettlements[
      Math.floor(pastSettlements.length * 0.4)
    ];
    if (target) {
      const expenses = findExpenses(target.showId);
      const sound = expenses.find((e) => e.category === "sound");
      if (sound) {
        const original = sound.enteredAt as Date;
        const dupTime = new Date(original);
        dupTime.setHours(dupTime.getHours() + 3);
        expensesToInsert.push({
          id: `exp_${target.showId}_dup`,
          showId: target.showId,
          category: "sound",
          amount: sound.amount,
          description: sound.description,
          approved: true,
          absorbedByVenue: false,
          enteredByUserId: MARCUS_ID, // entered by GM the second time
          enteredAt: dupTime,
        });
      }
    }
  }

  // BC9: Wrong dealType — prose describes a Vs deal, structured field says
  //      percentage_of_net (renegotiated up from %-only, never updated the type)
  {
    const targetDeal = dealsToInsert.find(
      (d) => d.dealType === "percentage_of_net" && d.percentage === 0.85,
    );
    if (targetDeal) {
      targetDeal.guaranteeAmount = 3500;
      targetDeal.dealNotesFreetext =
        `$3,500 guarantee vs 85% of net after expenses, whichever greater. ` +
        `Renegotiated up from %-only deal three weeks before show — agent insisted on a floor. ` +
        `Expense cap $${targetDeal.expenseCap}, hospitality $${targetDeal.hospitalityCap}.`;
    }
  }

  // BC10: CountsTowardGross contradiction — flag false but note says "agreed counts"
  {
    const target = compsToInsert.find(
      (c) => c.category === "label" && !c.countsTowardGross,
    );
    if (target) {
      target.notes =
        "Per Sarah Kim email 4/12 — agreed these count toward gross at face value. Flag still says no, doesn't matter for this show but flag for next time.";
    }
  }

  // BC11: Stale priorShowCount — artist has many prior shows, field says 0
  // Pick an artist who appears frequently
  {
    const artistCounts: Record<string, number> = {};
    for (const s of showsToInsert) {
      artistCounts[s.artistId] = (artistCounts[s.artistId] ?? 0) + 1;
    }
    const frequent = Object.entries(artistCounts)
      .filter(([, c]) => c >= 4)
      .sort(([, a], [, b]) => b - a);
    if (frequent.length > 1) {
      // Pick the SECOND-most-frequent so the most-frequent stays accurate
      const [artistId] = frequent[1];
      // We need to mutate the artist insertion list — find it
      // (already inserted into DB above, so we'll do this via raw update)
      // Better approach: track this for post-insert update
      breadcrumbsToFinalize.push({ kind: "artist_priorshows", artistId });
    }
  }

  // BC12: WME / Daniel Hwang pattern — multiple disputed marketing recoups across shows
  // Find Daniel Hwang's agent ID
  const danielHwang = AGENT_DEFS.find((a) => a.name === "Daniel Hwang");
  if (danielHwang) {
    // Find shows where the artist's agent is Daniel Hwang
    const hwangArtistIds = ARTIST_DEFS.filter(
      (a) => artistAgentMap.get(a.id) === danielHwang.id,
    ).map((a) => a.id);

    const hwangShows = showsToInsert
      .filter((s) => hwangArtistIds.includes(s.artistId))
      .map((s) => s.id as string);

    // Pick up to 5 of those shows that already have settlements, and ensure
    // each has a disputed marketing recoup. This creates a pattern: anyone
    // querying "disputes by agent" sees Daniel Hwang light up.
    let planted = 0;
    for (const showId of hwangShows) {
      if (planted >= 5) break;
      const stl = findSettlement(showId);
      if (!stl || stl.status === "draft" || stl.status === "voided") continue;

      const existing: Recoup[] = stl.recoupsJson
        ? JSON.parse(stl.recoupsJson as string)
        : [];
      // Skip if already has a disputed marketing recoup (don't double-plant)
      if (existing.some((r) => r.category === "marketing" && r.status === "disputed")) {
        continue;
      }

      const amount = 250 + Math.floor(rnd() * 600);
      existing.push({
        id: `recoup_${showId}_hwang_pattern`,
        category: "marketing",
        label: "Marketing recoup (post-show pushback)",
        amount,
        status: "disputed",
      });
      stl.recoupsJson = JSON.stringify(existing);
      planted++;
    }
    console.log(`   BC12: Planted ${planted} Daniel Hwang marketing-recoup disputes`);
  }

  // -------- Inject the Coastal Spell March 14, 2025 dispute --------
  const coastalDate = "2025-03-14";
  const coastalShowId = "show_coastal_spell_dispute";
  const coastalShowDate = new Date(coastalDate);
  showsToInsert.push({
    id: coastalShowId,
    venueId: VENUE_ID,
    artistId: "art_coastal_spell",
    date: coastalDate,
    status: "settled",
    doorsTime: "19:30",
    setTime: "21:00",
    roomConfig: "standing",
    internalNotes:
      "[Mariana, March 19] Settlement disputed by Daniel Hwang at WME re: marketing recoup interpretation. Marcus signed off on additional $720 to make it go away. See dispute-thread for full email chain. Going forward — get marketing recoup language explicit in the deal email.",
    createdAt: coastalShowDate,
  });
  dealsToInsert.push({
    id: `deal_${coastalShowId}`,
    showId: coastalShowId,
    dealType: "vs",
    guaranteeAmount: 5000,
    percentage: 0.8,
    percentageBasis: "net",
    expenseCap: 2500,
    hospitalityCap: 500,
    bonusesJson: JSON.stringify([
      {
        type: "gross_threshold",
        label: "+$1,000 if gross > $25,000",
        threshold: 25000,
        amount: 1000,
        stacks: false,
      },
    ] as Bonus[]),
    dealRecoupsJson: JSON.stringify([
      {
        id: `dealrecoup_${coastalShowId}_0`,
        category: "marketing",
        label: "Spotify pre-show ad spend",
        amount: 900,
        insideExpenseCap: true, // Daniel's (prevailing) interpretation — inside $2,500 cap
      },
    ] as DealRecoup[]),
    dealNotesFreetext:
      "$5,000 vs 80% of net after expenses, whichever greater. Expenses capped $2,500. Hospitality cap $500. +$1,000 bonus over $25k gross. Marketing recoup of $900 against gross. (Note added 3/19/25: this deal email was ambiguous — recoup interpretation disputed by WME, resolved with $720 concession.)",
    createdAt: coastalShowDate,
  });
  ticketSalesToInsert.push({
    id: `ts_${coastalShowId}`,
    showId: coastalShowId,
    qty: 620,
    gross: 19840,
    fees: 1984,
    capturedAt: coastalShowDate,
  });
  // Comps for Coastal Spell — they were a draw, lots of GL
  compsToInsert.push(
    { id: `comp_${coastalShowId}_0`, showId: coastalShowId, category: "artist_gl", count: 24, faceValue: 32, countsTowardGross: false, notes: null },
    { id: `comp_${coastalShowId}_1`, showId: coastalShowId, category: "label", count: 6, faceValue: 32, countsTowardGross: false, notes: "Captured Tracks, A&R" },
    { id: `comp_${coastalShowId}_2`, showId: coastalShowId, category: "press", count: 4, faceValue: 32, countsTowardGross: false, notes: null },
    { id: `comp_${coastalShowId}_3`, showId: coastalShowId, category: "venue_staff", count: 6, faceValue: 32, countsTowardGross: false, notes: null },
  );
  // Expenses — note marketing is now a regular expense; the disputed marketing
  // recoup is a separate line-item in recoups (where it conceptually belongs).
  for (const [idx, e] of [
    { category: "sound" as const, amount: 400, description: null },
    { category: "lights" as const, amount: 220, description: null },
    { category: "production" as const, amount: 280, description: null },
    { category: "hospitality" as const, amount: 480, description: null },
    { category: "backline" as const, amount: 220, description: null },
  ].entries()) {
    expensesToInsert.push({
      id: `exp_${coastalShowId}_${idx}`,
      showId: coastalShowId,
      category: e.category,
      amount: e.amount,
      description: e.description,
      approved: true,
      absorbedByVenue: false,
      enteredByUserId: MARIANA_ID,
      enteredAt: coastalShowDate,
    });
  }

  const coastalRecoups: Recoup[] = [
    {
      id: `recoup_${coastalShowId}_0`,
      category: "marketing",
      label: "Spotify pre-show ad spend",
      amount: 900,
      status: "disputed",
      insideExpenseCap: true,
    },
  ];

  // Coastal Spell stage = disputed (in-flight, not yet resolved in product —
  // narratively, Marcus authorized the concession but it's not been formalized
  // back into the system as a revision).
  settlementsToInsert.push({
    id: `stl_${coastalShowId}`,
    showId: coastalShowId,
    status: "disputed",
    draftedAt: new Date("2025-03-15T02:00:00"),
    submittedAt: new Date("2025-03-15T11:00:00"),
    reviewStartedAt: new Date("2025-03-16T09:00:00"),
    disputedAt: new Date("2025-03-18T14:00:00"),
    completedAt: new Date("2025-03-18T14:00:00"),
    completedByUserId: MARIANA_ID,
    grossBoxOffice: 19840,
    netBoxOffice: 17856,
    totalExpenses: 1600,
    totalToArtist: 12285,
    recoupsJson: JSON.stringify(coastalRecoups),
    signoffText: "OK — but flag any future marketing recoup deals.",
    notes:
      "Disputed by WME (Daniel Hwang) on 3/18 over the $900 marketing recoup. Marcus authorized additional $720 to resolve, but the formal revision hasn't been pushed back into the system yet. Final agreed: $12,285 (vs originally calculated $11,565). See email thread for context. Going forward: deal emails must specify marketing recoup as inside or outside expense cap.",
  });

  // Bulk insert
  console.log(`   Inserting ${showsToInsert.length} shows…`);
  const chunkArr = <T>(arr: T[], size: number): T[][] =>
    Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

  for (const c of chunkArr(showsToInsert, 50)) await db.insert(shows).values(c);
  for (const c of chunkArr(dealsToInsert, 50)) await db.insert(deals).values(c);
  for (const c of chunkArr(ticketSalesToInsert, 50)) await db.insert(ticketSales).values(c);
  for (const c of chunkArr(compsToInsert, 50)) await db.insert(comps).values(c);
  for (const c of chunkArr(expensesToInsert, 50)) await db.insert(expenses).values(c);
  for (const c of chunkArr(settlementsToInsert, 50)) await db.insert(settlements).values(c);

  // BC11 finalization: artist's priorShowCount left stale despite many shows
  for (const bc of breadcrumbsToFinalize) {
    if (bc.kind === "artist_priorshows") {
      await db
        .update(artists)
        .set({ priorShowCount: 0 })
        .where(eq(artists.id, bc.artistId));
    }
  }

  // Stats
  const stageCounts: Record<string, number> = {};
  for (const s of settlementsToInsert) {
    stageCounts[s.status as string] = (stageCounts[s.status as string] ?? 0) + 1;
  }
  const recoupCount = settlementsToInsert.filter((s) => s.recoupsJson).length;
  const bonusCount = dealsToInsert.filter((d) => d.bonusesJson).length;

  console.log("✅ Seeded:");
  console.log(`   1 venue, 2 users`);
  console.log(`   ${AGENCIES.length} agencies, ${AGENT_DEFS.length} agents`);
  console.log(`   ${ARTIST_DEFS.length} artists`);
  console.log(`   ${showsToInsert.length} shows`);
  console.log(`   ${ticketSalesToInsert.length} ticket sale records`);
  console.log(`   ${compsToInsert.length} comp records (${compsToInsert.reduce((s, c) => s + (c.count ?? 0), 0)} comp tickets total)`);
  console.log(`   ${expensesToInsert.length} expenses`);
  console.log(`   ${settlementsToInsert.length} settlements (${Object.entries(stageCounts).map(([k, v]) => `${k}:${v}`).join(", ")})`);
  console.log(`   ${recoupCount} settlements have recoup line items`);
  console.log(`   ${bonusCount} deals have structured bonuses`);
  console.log(`   1 named dispute (Coastal Spell, March 2025) injected for narrative continuity`);
}

main()
  .then(() => { client.close(); process.exit(0); })
  .catch((err) => { console.error(err); client.close(); process.exit(1); });
