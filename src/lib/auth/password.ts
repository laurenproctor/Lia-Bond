import { z } from "zod";

/**
 * Password policy.
 *
 * Its own module because both the server action that enforces it and the form
 * that states it need the number, and a `"use server"` file can only export
 * async functions — so the action cannot be the source of truth for a
 * constant. Two hard-coded copies would drift the first time it changed, and
 * the failure would be a form promising one rule while the server applied
 * another.
 */

/**
 * Above Supabase's default of six.
 *
 * Length is the only property enforced. Composition rules — a digit, a symbol,
 * mixed case — reliably produce `Passw0rd!` and reliably annoy the people who
 * already use a manager, which generates something stronger than any rule
 * would think to demand.
 */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * A new password and its confirmation.
 *
 * Lives here rather than in the action so it can be tested directly. The
 * confirmation is checked server-side as well as by the form: `minLength` on an
 * input is a hint to the browser, not a constraint on what arrives.
 */
export const newPasswordSchema = z
  .object({
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`),
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, {
    message: "Those passwords do not match.",
    path: ["confirm"],
  });

export type NewPasswordInput = z.infer<typeof newPasswordSchema>;
