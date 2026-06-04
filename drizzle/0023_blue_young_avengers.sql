CREATE TABLE "kb_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_assignments_offer_id_user_id_unique" UNIQUE("offer_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "kb_lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"module_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"duration_label" text DEFAULT '' NOT NULL,
	"duration_mins" integer DEFAULT 0 NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"title" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"accent" text DEFAULT '#97A4D6' NOT NULL,
	"level" text DEFAULT 'New' NOT NULL,
	"core" boolean DEFAULT false NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_progress_user_id_lesson_id_unique" UNIQUE("user_id","lesson_id")
);
--> statement-breakpoint
ALTER TABLE "kb_assignments" ADD CONSTRAINT "kb_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_assignments" ADD CONSTRAINT "kb_assignments_offer_id_kb_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."kb_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_lessons" ADD CONSTRAINT "kb_lessons_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_lessons" ADD CONSTRAINT "kb_lessons_module_id_kb_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."kb_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_lessons" ADD CONSTRAINT "kb_lessons_offer_id_kb_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."kb_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_modules" ADD CONSTRAINT "kb_modules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_modules" ADD CONSTRAINT "kb_modules_offer_id_kb_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."kb_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_offers" ADD CONSTRAINT "kb_offers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_progress" ADD CONSTRAINT "kb_progress_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_progress" ADD CONSTRAINT "kb_progress_lesson_id_kb_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."kb_lessons"("id") ON DELETE cascade ON UPDATE no action;