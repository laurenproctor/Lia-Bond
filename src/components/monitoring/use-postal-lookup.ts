"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { lookupPostalCodeAction } from "@/app/actions/geo";
import {
  postalLabelFor,
  supportsPostalLookup,
  type MonitoringCountry,
} from "@/lib/geo/countries";

/**
 * The country / postal code / city / region behaviour, shared by the two forms
 * that have it.
 *
 * A hook rather than a component, deliberately. The onboarding configurator and
 * the News & Media query editor render on two different design systems — the
 * public-site palette against the product's purple, 46px fields against 36px —
 * so a shared component would have to be parameterised into something neither
 * screen reads clearly. What actually repeats between them is not markup, it is
 * the *rules*: clearing the country clears everything under it, a lookup is
 * debounced and only attempted where it can succeed, a stale response never
 * overwrites a newer one, and typing over an auto-filled city is allowed and
 * silences the auto-fill note. Those live here once; each screen renders its
 * own fields.
 */

/** The four fields, in the shape `monitoringQuerySchema` stores them. */
export interface Locality {
  sourceCountry: string | null;
  postalCode: string | null;
  localityCity: string | null;
  localityRegion: string | null;
}

export type PostalLookupStatus =
  /** Nothing attempted, or the person has since edited the result by hand. */
  | "idle"
  /** A request is in flight. */
  | "looking-up"
  /** City and region were filled in from a lookup. */
  | "filled"
  /** The lookup did not answer. The fields are the person's to fill in. */
  | "failed";

export interface PostalLookup {
  status: PostalLookupStatus;
  /** What to show beneath the postal field. Null when there is nothing to say. */
  message: string | null;
  /** True when the chosen country has a lookup behind it. */
  lookupSupported: boolean;
  /** "ZIP code", "Postcode", "CAP" — what this country calls it. */
  postalLabel: string;
  /** Choosing a country. Null clears it, and everything under it. */
  setCountry: (code: string | null) => void;
  setPostalCode: (next: string) => void;
  setCity: (next: string) => void;
  setRegion: (next: string) => void;
}

/**
 * Long enough that typing "10012" is one request rather than four, short
 * enough that the city appears while the person is still looking at the field.
 */
const DEBOUNCE_MS = 600;

/**
 * Below this, a postal code cannot be complete in any supported country, and
 * asking would only ever produce "no place matched" — which reads as an error
 * about something the person is still halfway through typing.
 */
const MIN_LOOKUP_LENGTH = 3;

export function usePostalLookup({
  value,
  onChange,
}: {
  value: Locality;
  onChange: (next: Locality) => void;
}): PostalLookup {
  const [status, setStatus] = useState<PostalLookupStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Monotonic request counter.
   *
   * Server actions are not guaranteed to resolve in the order they were sent,
   * so a slow lookup for "1001" could land after a fast one for "10012" and
   * overwrite the right answer with a stale one. Only the newest request is
   * allowed to write.
   */
  const sequence = useRef(0);

  // `onChange` and `value` are read through refs inside the debounced callback
  // so the timer never captures a stale closure, and so `setPostalCode` does
  // not have to be re-created — and the timer re-scheduled — on every keystroke
  // the parent re-renders for.
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });

  // A pending lookup must not fire into an unmounted form.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      sequence.current += 1;
    };
  }, []);

  /** Writes through the current `onChange`, never a captured one. */
  const emit = useCallback((next: Locality) => {
    latest.current.onChange(next);
  }, []);

  const runLookup = useCallback(async (countryCode: string, postalCode: string) => {
    const ticket = (sequence.current += 1);
    setStatus("looking-up");
    setMessage(null);

    const result = await lookupPostalCodeAction({ countryCode, postalCode });
    if (ticket !== sequence.current) return;

    if (!result.ok) {
      // The city and region already on screen are left exactly as they are. A
      // failed lookup is not evidence that what somebody typed is wrong.
      setStatus("failed");
      setMessage(result.error);
      return;
    }

    setStatus("filled");
    setMessage(null);
    emit({
      ...latest.current.value,
      localityCity: result.data.city,
      localityRegion: result.data.region || null,
    });
  }, [emit]);

  const setCountry = useCallback((code: string | null) => {
    if (timer.current) clearTimeout(timer.current);
    // Abandon anything in flight: its answer is about the old country.
    sequence.current += 1;
    setStatus("idle");
    setMessage(null);

    // Everything under the country goes with it. A postal code has no meaning
    // without one, and keeping "10012 / New York / NY" after switching to
    // Germany would leave the form asserting a place that does not exist there
    // — and would save it, because the fields are what gets saved.
    emit({
      sourceCountry: code,
      postalCode: null,
      localityCity: null,
      localityRegion: null,
    });
  }, [emit]);

  const setPostalCode = useCallback((next: string) => {
    const country = latest.current.value.sourceCountry;
    const trimmed = next.trim();

    emit({
      ...latest.current.value,
      postalCode: trimmed.length === 0 ? null : next,
    });

    if (timer.current) clearTimeout(timer.current);
    sequence.current += 1;
    setStatus("idle");
    setMessage(null);

    if (!country || !supportsPostalLookup(country)) return;
    if (trimmed.length < MIN_LOOKUP_LENGTH) return;

    timer.current = setTimeout(() => {
      void runLookup(country, trimmed);
    }, DEBOUNCE_MS);
  }, [emit, runLookup]);

  /**
   * Typing over an auto-filled value.
   *
   * Allowed everywhere, including in countries the lookup covers: it resolves
   * an area rather than an address in some of them, and the person standing in
   * the restaurant knows the answer better than the provider does. Editing
   * drops the status back to `idle` so a "filled in from the postal code" note
   * cannot sit above a value the lookup did not produce.
   */
  const setCity = useCallback((next: string) => {
    sequence.current += 1;
    setStatus("idle");
    setMessage(null);
    emit({
      ...latest.current.value,
      localityCity: next.trim().length === 0 ? null : next,
    });
  }, [emit]);

  const setRegion = useCallback((next: string) => {
    sequence.current += 1;
    setStatus("idle");
    setMessage(null);
    emit({
      ...latest.current.value,
      localityRegion: next.trim().length === 0 ? null : next,
    });
  }, [emit]);

  return {
    status,
    message,
    lookupSupported: supportsPostalLookup(value.sourceCountry),
    postalLabel: postalLabelFor(value.sourceCountry),
    setCountry,
    setPostalCode,
    setCity,
    setRegion,
  };
}

/** Re-exported so a form needs one import for the picker and the behaviour. */
export type { MonitoringCountry };
