/**
 * Types for the distribution-center twin. The network (centers, stores,
 * weekly dollar demand by category) comes from candystore_mcp; the building,
 * catalog, roster and standards are this project's own mock inputs.
 */

/** A candystore category: "traditional" or "specialty:<segment>". */
export type Category = string;

// ---------------------------------------------------------------------------
// Network snapshot from candystore_mcp
// ---------------------------------------------------------------------------

export interface NetworkStore {
  id: string;
  name: string;
  type: "general" | "specialty";
  dc: string;
  lon: number;
  lat: number;
  segments: string[];
  /** Annual retail dollars by category, after candystore's supply caps. */
  revenueBy: Record<Category, number>;
}

export interface NetworkDc {
  id: string;
  name: string;
  lon: number;
  lat: number;
  /** candystore's assumed weekly capacity, retail dollars by category. */
  capacity: Record<Category, number>;
  /** Average-week retail dollars routed here by category. */
  weeklyDemand: Record<Category, number>;
  stores: string[];
}

export interface Network {
  source: string;
  fetchedAt: string;
  /** The candystore scenario this snapshot describes; empty for the baseline. */
  scenario: Record<string, unknown>;
  dcs: NetworkDc[];
  stores: NetworkStore[];
  segments: Array<{ id: string; label: string }>;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface Supplier {
  id: string;
  name: string;
  kind: "domestic" | "importer";
  /** Mean and standard deviation of lead time, days. */
  leadDays: number;
  leadSdDays: number;
  /** Weekday the buyer places orders, 1 = Monday … 7 = Sunday. */
  orderDay: number;
}

export interface Sku {
  id: string;
  name: string;
  category: Category;
  supplier: string;
  /** Stores order and the DC picks in inner packs (display boxes). */
  innerRetail: number;
  /** Supplier ships master cases of inners, on single-SKU pallets. */
  innersPerCase: number;
  casesPerPallet: number;
  innerCubeFt: number;
  /** Share of the category's dollar demand, summing to 1 within a category. */
  velocityShare: number;
}

export interface Catalog {
  generatedAt: string;
  seed: number;
  suppliers: Supplier[];
  skus: Sku[];
}

// ---------------------------------------------------------------------------
// Site: building, zones, doors, equipment, times
// ---------------------------------------------------------------------------

export interface RackZone {
  originX: number;
  originY: number;
  aisles: number;
  baysPerSide: number;
  levels: number;
  bayWidthFt: number;
  aisleWidthFt: number;
  rackDepthFt: number;
}

export interface PickZone extends RackZone {
  slotsPerBay: number;
  /** Pick-face capacity in master cases. */
  faceCases: number;
}

export interface Shift {
  id: string;
  /** "HH:MM", local. */
  start: string;
  end: string;
  /** Unpaid meal break, taken mid-shift. */
  breakMin: number;
  /** Paid but not on the floor: start-up meeting, equipment checks, cycle counts. */
  indirectMin: number;
}

export interface Site {
  id: string;
  building: { widthFt: number; depthFt: number };
  doors: { inbound: number; outbound: number };
  equipment: { forklifts: number; palletJacks: number };
  reserve: RackZone;
  pick: PickZone;
  /** Weekdays stores receive deliveries, by store type (1 = Monday). */
  deliveryDays: { general: number[]; specialty: number[] };
  times: {
    /** Store orders drop into the warehouse system at this time the day before the truck leaves. */
    orderRelease: string;
    /** Store trucks leave at this time on the delivery day, after the morning's picking. */
    truckDeparture: string;
    inboundWindow: [string, string];
  };
  shifts: Shift[];
  /** Days the building works, 1 = Monday. */
  operatingDays: number[];
}

// ---------------------------------------------------------------------------
// Workforce
// ---------------------------------------------------------------------------

export type Process = "unload" | "receive" | "putaway" | "replenish" | "pick" | "pack" | "load";
export const PROCESSES: Process[] = ["unload", "receive", "putaway", "replenish", "pick", "pack", "load"];

/** Skills a worker can hold. Forklift work (putaway, replenish) needs the certification. */
export type Skill = "receive" | "forklift" | "pick" | "pack" | "load";
export const SKILLS: Skill[] = ["receive", "forklift", "pick", "pack", "load"];

export const PROCESS_SKILL: Record<Process, Skill> = {
  unload: "receive",
  receive: "receive",
  putaway: "forklift",
  replenish: "forklift",
  pick: "pick",
  pack: "pack",
  load: "load",
};

export interface Worker {
  id: string;
  dc: string;
  role: string;
  type: "full-time" | "part-time" | "temp";
  homeShift: string;
  skills: Skill[];
  /** Multiplier on engineered standards; 1.1 works 10% faster. */
  productivity: number;
  hourlyRate: number;
  maxWeeklyHours: number;
}

export interface Roster {
  generatedAt: string;
  seed: number;
  workers: Worker[];
}

/** Engineered labor standards, minutes. */
export interface LaborStandards {
  unloadPerPallet: number;
  unloadPerTruck: number;
  receivePerPallet: number;
  receivePerCase: number;
  /** Compliance labels on imported specialty candy, per master case at receipt. */
  labelPerImportCase: number;
  putawayHandling: number;
  replenHandling: number;
  pickPerLine: number;
  pickPerInner: number;
  /** Cart setup, tote labels and drop-off at the pack station, per tour. */
  pickPerTour: number;
  /** Extra seconds per line for slots below or above the golden zone. */
  pickBendReachSec: number;
  packPerPallet: number;
  loadPerPallet: number;
  loadPerTruck: number;
  walkFtPerMin: number;
  forkliftFtPerMin: number;
  liftMinPerLevel: number;
  cartCubeFt: number;
  palletCubeFt: number;
  /** Clear height of one pick-face level, which with bay width and shelf depth caps a face's cases. */
  slotHeightFt: number;
  /** Optimized slotting sizes each face to hold this many days of the SKU's demand. */
  faceDaysOfSupply: number;
}

export interface CostRates {
  overtimeMultiplier: number;
  tempHourly: number;
  /** Temps are slower while they learn the building. */
  tempProductivity: number;
  crossTrainCost: number;
  crossTrainWeeks: number;
  hireCost: number;
  hireWeeks: number;
  /** Share of retail value that is cost of goods, for inventory valuation. */
  costOfGoods: number;
}
