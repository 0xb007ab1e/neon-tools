import { z } from 'zod';

/**
 * Schema for a lifecycle command delivered over a queue. Validated at the boundary because the
 * payload is **untrusted input** (topic-event-driven, std-owasp-proactive). Each command carries a
 * stable `id` for at-least-once dedupe. The irreversible `purge` is deliberately NOT a queue command
 * — hard-deletes stay on the CLI/HTTP control plane (defense in depth).
 */
const LifecycleCommandSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    type: z.literal('provision'),
    slug: z.string().min(1),
    region: z.string().min(1).optional(),
    residency: z.enum(['us', 'eu', 'apac']).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ id: z.string().min(1), type: z.literal('suspend'), tenantId: z.string().min(1) }),
  z.object({ id: z.string().min(1), type: z.literal('resume'), tenantId: z.string().min(1) }),
  z.object({ id: z.string().min(1), type: z.literal('offboard'), tenantId: z.string().min(1) }),
]);

/** A validated lifecycle command (provision / suspend / resume / offboard). */
export type LifecycleCommand = z.infer<typeof LifecycleCommandSchema>;

/**
 * Parse + validate an untrusted lifecycle-command payload.
 *
 * @param raw - The raw message body.
 * @returns The validated command.
 * @throws ZodError if the payload is not a well-formed command.
 */
export function parseLifecycleCommand(raw: unknown): LifecycleCommand {
  return LifecycleCommandSchema.parse(raw);
}
