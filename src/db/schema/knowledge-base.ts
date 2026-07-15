import { pgTable, text, integer, boolean, jsonb, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** Type-specific lesson body. All optional — only the fields relevant to the
 *  lesson's `type` are populated. Resources/files are linked URLs (no upload). */
export interface KbLessonContent {
  // video
  loom?: string;
  transcript?: string;
  resources?: { name: string; url: string }[];
  // article
  body?: { h: string; p: string }[];
  // script
  script?: { hook: string; points: string[]; objections: { o: string; a: string }[] };
  // quiz
  questions?: { q: string; options: string[]; answer: number }[];
  // file — either an uploaded file (served by us; carries `key`) or a linked URL
  files?: { name: string; url: string; type?: string; key?: string; size?: number }[];
  // faq
  items?: { q: string; a: string }[];
}

/** An "offer" — a client company / product reps learn to sell. Top of the
 *  Offer → Module → Lesson hierarchy. */
export const kbOffers = pgTable("kb_offers", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tagline: text("tagline").notNull().default(""),
  category: text("category").notNull().default(""),
  accent: text("accent").notNull().default("#97A4D6"),
  level: text("level").notNull().default("New"),
  /** Marks a required onboarding track shown first on the home hub. */
  core: boolean("core").notNull().default(false),
  about: text("about").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const kbModules = pgTable("kb_modules", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  offerId: text("offer_id")
    .notNull()
    .references(() => kbOffers.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const kbLessons = pgTable("kb_lessons", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  moduleId: text("module_id")
    .notNull()
    .references(() => kbModules.id, { onDelete: "cascade" }),
  /** Denormalized for access checks / queries without joining up the tree. */
  offerId: text("offer_id")
    .notNull()
    .references(() => kbOffers.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  type: text("type").notNull(), // video|article|script|quiz|file|faq
  durationLabel: text("duration_label").notNull().default(""),
  durationMins: integer("duration_mins").notNull().default(0),
  summary: text("summary").notNull().default(""),
  content: jsonb("content").$type<KbLessonContent>().notNull().default({}),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Which members an admin has allocated an offer to learn. */
export const kbAssignments = pgTable(
  "kb_assignments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    offerId: text("offer_id")
      .notNull()
      .references(() => kbOffers.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    assignedBy: text("assigned_by"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.offerId, t.userId)],
);

/** Per-user lesson completion — the server-side replacement for localStorage. */
export const kbProgress = pgTable(
  "kb_progress",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => kbLessons.id, { onDelete: "cascade" }),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.userId, t.lessonId)],
);
