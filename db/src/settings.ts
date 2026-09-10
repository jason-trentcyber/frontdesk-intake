import { z } from "zod";

// Validates orgs.settings at the application boundary; the jsonb column
// itself has no DB-level shape constraint (ADR-0018).
export const orgSettingsSchema = z.object({
  categories: z.array(z.string()),
  lanes: z.record(z.string(), z.string()),
  similarityFloor: z.number().min(0).max(1).optional(),
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;
