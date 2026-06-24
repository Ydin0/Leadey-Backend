/**
 * US (NANP) area-code → state + timezone reference, for local-presence dialing.
 * Timezone is the area code's predominant IANA zone (a handful of codes span
 * two zones; the larger-population zone is used). No timezone DB is bundled.
 */

export interface AreaInfo {
  state: string; // 2-letter
  stateName: string;
  timezone: string;
}

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "Washington, D.C.",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

// state + timezone → its area codes. Split-zone states appear in multiple rows.
const GROUPS: { state: string; tz: string; codes: number[] }[] = [
  { state: "AL", tz: "America/Chicago", codes: [205, 251, 256, 334, 938] },
  { state: "AK", tz: "America/Anchorage", codes: [907] },
  { state: "AZ", tz: "America/Phoenix", codes: [480, 520, 602, 623, 928] },
  { state: "AR", tz: "America/Chicago", codes: [479, 501, 870] },
  { state: "CA", tz: "America/Los_Angeles", codes: [209, 213, 279, 310, 323, 341, 350, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 820, 831, 840, 858, 909, 916, 925, 949, 951] },
  { state: "CO", tz: "America/Denver", codes: [303, 719, 720, 970, 983] },
  { state: "CT", tz: "America/New_York", codes: [203, 475, 860, 959] },
  { state: "DE", tz: "America/New_York", codes: [302] },
  { state: "DC", tz: "America/New_York", codes: [202] },
  { state: "FL", tz: "America/New_York", codes: [239, 305, 321, 324, 352, 386, 407, 448, 561, 656, 689, 727, 754, 772, 786, 813, 850, 863, 904, 941, 954] },
  { state: "GA", tz: "America/New_York", codes: [229, 404, 470, 478, 678, 706, 762, 770, 912, 943] },
  { state: "HI", tz: "Pacific/Honolulu", codes: [808] },
  { state: "ID", tz: "America/Boise", codes: [208, 986] },
  { state: "IL", tz: "America/Chicago", codes: [217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730, 773, 779, 815, 847, 872] },
  { state: "IN", tz: "America/Indiana/Indianapolis", codes: [260, 317, 463, 574, 765, 812, 930] },
  { state: "IN", tz: "America/Chicago", codes: [219] },
  { state: "IA", tz: "America/Chicago", codes: [319, 515, 563, 641, 712] },
  { state: "KS", tz: "America/Chicago", codes: [316, 620, 785, 913] },
  { state: "KY", tz: "America/New_York", codes: [502, 606, 859] },
  { state: "KY", tz: "America/Chicago", codes: [270, 364] },
  { state: "LA", tz: "America/Chicago", codes: [225, 318, 337, 504, 985] },
  { state: "ME", tz: "America/New_York", codes: [207] },
  { state: "MD", tz: "America/New_York", codes: [240, 301, 410, 443, 667] },
  { state: "MA", tz: "America/New_York", codes: [339, 351, 413, 508, 617, 774, 781, 857, 978] },
  { state: "MI", tz: "America/Detroit", codes: [231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 947, 989] },
  { state: "MI", tz: "America/Chicago", codes: [906] },
  { state: "MN", tz: "America/Chicago", codes: [218, 320, 507, 612, 651, 763, 952] },
  { state: "MS", tz: "America/Chicago", codes: [228, 601, 662, 769] },
  { state: "MO", tz: "America/Chicago", codes: [314, 417, 557, 573, 636, 660, 816] },
  { state: "MT", tz: "America/Denver", codes: [406] },
  { state: "NE", tz: "America/Chicago", codes: [308, 402, 531] },
  { state: "NV", tz: "America/Los_Angeles", codes: [702, 725, 775] },
  { state: "NH", tz: "America/New_York", codes: [603] },
  { state: "NJ", tz: "America/New_York", codes: [201, 551, 609, 640, 732, 848, 856, 862, 908, 973] },
  { state: "NM", tz: "America/Denver", codes: [505, 575] },
  { state: "NY", tz: "America/New_York", codes: [212, 315, 332, 347, 363, 516, 518, 585, 607, 631, 646, 680, 716, 718, 838, 845, 914, 917, 929, 934] },
  { state: "NC", tz: "America/New_York", codes: [252, 336, 704, 743, 828, 910, 919, 980, 984] },
  { state: "ND", tz: "America/Chicago", codes: [701] },
  { state: "OH", tz: "America/New_York", codes: [216, 220, 234, 283, 326, 330, 380, 419, 440, 513, 567, 614, 740, 937] },
  { state: "OK", tz: "America/Chicago", codes: [405, 539, 572, 580, 918] },
  { state: "OR", tz: "America/Los_Angeles", codes: [458, 503, 541, 971] },
  { state: "PA", tz: "America/New_York", codes: [215, 223, 267, 272, 412, 445, 484, 570, 582, 610, 717, 724, 814, 835, 878] },
  { state: "RI", tz: "America/New_York", codes: [401] },
  { state: "SC", tz: "America/New_York", codes: [803, 839, 843, 854, 864] },
  { state: "SD", tz: "America/Chicago", codes: [605] },
  { state: "TN", tz: "America/Chicago", codes: [615, 629, 731, 901, 931] },
  { state: "TN", tz: "America/New_York", codes: [423, 865] },
  { state: "TX", tz: "America/Chicago", codes: [210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469, 512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 936, 940, 956, 972, 979] },
  { state: "TX", tz: "America/Denver", codes: [915] },
  { state: "UT", tz: "America/Denver", codes: [385, 435, 801] },
  { state: "VT", tz: "America/New_York", codes: [802] },
  { state: "VA", tz: "America/New_York", codes: [276, 434, 540, 571, 703, 757, 804, 826, 948] },
  { state: "WA", tz: "America/Los_Angeles", codes: [206, 253, 360, 425, 509, 564] },
  { state: "WV", tz: "America/New_York", codes: [304, 681] },
  { state: "WI", tz: "America/Chicago", codes: [262, 274, 414, 534, 608, 715, 920] },
  { state: "WY", tz: "America/Denver", codes: [307] },
];

export const AREA_CODES: Record<string, AreaInfo> = (() => {
  const map: Record<string, AreaInfo> = {};
  for (const g of GROUPS) {
    for (const c of g.codes) {
      map[String(c)] = { state: g.state, stateName: STATE_NAMES[g.state] || g.state, timezone: g.tz };
    }
  }
  return map;
})();

/** The 3-digit US area code from an E.164 / raw phone, or null when not US NANP. */
export function areaCodeOf(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const d = phone.replace(/[^\d]/g, "");
  let ac: string | null = null;
  if (d.length === 11 && d.startsWith("1")) ac = d.slice(1, 4);
  else if (d.length === 10) ac = d.slice(0, 3);
  else return null;
  // NANP area codes are N (2-9) X X.
  if (!/^[2-9]\d\d$/.test(ac)) return null;
  return ac;
}

export function areaInfoOf(phone: string | null | undefined): AreaInfo | null {
  const ac = areaCodeOf(phone);
  return ac ? AREA_CODES[ac] ?? null : null;
}

export function stateOfAreaCode(ac: string | null | undefined): AreaInfo | null {
  return ac ? AREA_CODES[ac] ?? null : null;
}

// For the location-text fallback: full name (word-boundary) or ", XX" abbrev.
const STATE_ABBRS = Object.keys(STATE_NAMES);
const NAME_TO_ABBR: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_NAMES).map(([abbr, name]) => [name.toLowerCase(), abbr]),
);

/** Best-effort US state from a free-text location like "Austin, TX, USA". */
export function usStateFromText(loc: string | null | undefined): string | null {
  if (!loc) return null;
  const s = loc.toLowerCase();
  for (const [name, abbr] of Object.entries(NAME_TO_ABBR)) {
    if (s.includes(name)) return abbr;
  }
  // ", tx" / " tx," / " tx " token match (avoid matching random 2-letter runs).
  for (const abbr of STATE_ABBRS) {
    const re = new RegExp(`(^|[,\\s])${abbr.toLowerCase()}([,\\s]|$)`);
    if (re.test(s)) return abbr;
  }
  return null;
}

/** A representative timezone for a US state (first area code found for it). */
export function timezoneOfState(state: string | null | undefined): string | null {
  if (!state) return null;
  const g = GROUPS.find((x) => x.state === state);
  return g?.tz ?? null;
}
