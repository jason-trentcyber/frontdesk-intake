import { z } from "zod";

// Validates orgs.settings at the application boundary; the jsonb column
// itself has no DB-level shape constraint (ADR-0018).
export const orgSettingsSchema = z
  .object({
    categories: z.array(z.string()),
    lanes: z.record(z.string(), z.string()),
    // One line per category, rendered into the classify prompt so the
    // model is told what each label means instead of guessing from its
    // name (#152). Optional for orgs seeded before it existed; the prompt
    // falls back to the bare label for a category without one.
    categoryDescriptions: z.record(z.string(), z.string()).optional(),
    similarityFloor: z.number().min(0).max(1).optional(),
  })
  .refine(
    (s) =>
      s.categoryDescriptions === undefined ||
      Object.keys(s.categoryDescriptions).every((c) => s.categories.includes(c)),
    { message: "categoryDescriptions may only name configured categories" },
  );

export type OrgSettings = z.infer<typeof orgSettingsSchema>;
