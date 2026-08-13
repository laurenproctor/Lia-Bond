import { describe, expect, it, vi } from "vitest";
import {
  findMonitoringCountry,
  MONITORING_COUNTRIES,
  postalLabelFor,
  supportsPostalLookup,
} from "@/lib/geo/countries";
import {
  lookupPostalCode,
  normalisePostalCode,
  PostalLookupError,
  POSTAL_LOOKUP_MESSAGES,
} from "@/lib/geo/postal-lookup";

/**
 * The postal boundary and the country list behind it.
 *
 * `fetch` is injected, so every case here is a stub — nothing in this file
 * reaches the network. What is actually being pinned down is the behaviour the
 * two monitoring forms depend on: which countries may be offered, which of
 * them can auto-fill, and that every way the provider can fail arrives as
 * Lia's own sentence rather than as a crash or as the provider's words.
 */

const BEVERLY_HILLS = {
  "post code": "90210",
  country: "United States",
  places: [
    {
      "place name": "Beverly Hills",
      state: "California",
      "state abbreviation": "CA",
    },
  ],
};

function stubFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

/* -------------------------------------------------------------------------- */
/* The country list                                                            */
/* -------------------------------------------------------------------------- */

describe("MONITORING_COUNTRIES", () => {
  it("offers only codes GNews can filter on, as lowercase alpha-2", () => {
    for (const country of MONITORING_COUNTRIES) {
      expect(country.code).toMatch(/^[a-z]{2}$/);
    }
  });

  it("has no duplicate codes", () => {
    const codes = MONITORING_COUNTRIES.map((country) => country.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("names every country and its own word for a postal code", () => {
    for (const country of MONITORING_COUNTRIES) {
      expect(country.label.trim().length).toBeGreaterThan(0);
      expect(country.postalLabel.trim().length).toBeGreaterThan(0);
    }
  });

  it("resolves a stored sourceCountry case-insensitively", () => {
    expect(findMonitoringCountry("US")?.label).toBe("United States");
    expect(findMonitoringCountry(" gb ")?.label).toBe("United Kingdom");
  });

  it("treats an unset or unknown country as no country", () => {
    expect(findMonitoringCountry(null)).toBeNull();
    expect(findMonitoringCountry("")).toBeNull();
    // A real ISO code GNews does not accept. Offering it would promise a
    // market filter that silently does nothing.
    expect(findMonitoringCountry("nz")).toBeNull();
  });

  it("does not default an unset country to American vocabulary", () => {
    expect(postalLabelFor(null)).toBe("Postal code");
    expect(postalLabelFor("us")).toBe("ZIP code");
    expect(postalLabelFor("gb")).toBe("Postcode");
  });

  it("marks lookup support per country rather than assuming it", () => {
    expect(supportsPostalLookup("us")).toBe(true);
    expect(supportsPostalLookup("de")).toBe(true);
    // A supported *market* with no postal lookup behind it. The form still
    // offers the country; it just asks for the city directly.
    expect(supportsPostalLookup("ie")).toBe(false);
    expect(supportsPostalLookup("hk")).toBe(false);
    expect(supportsPostalLookup(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

describe("normalisePostalCode", () => {
  it("uppercases and collapses whitespace", () => {
    expect(normalisePostalCode("  ec1a   1bb ")).toBe("EC1A 1BB");
  });

  it("leaves a plain numeric code alone", () => {
    expect(normalisePostalCode("90210")).toBe("90210");
  });
});

/* -------------------------------------------------------------------------- */
/* Lookup                                                                      */
/* -------------------------------------------------------------------------- */

describe("lookupPostalCode", () => {
  it("returns the city and the state abbreviation", async () => {
    const fetchImpl = stubFetch(200, BEVERLY_HILLS);

    const place = await lookupPostalCode(
      { countryCode: "us", postalCode: "90210" },
      fetchImpl,
    );

    expect(place).toEqual({
      postalCode: "90210",
      city: "Beverly Hills",
      // "CA", not "California": what somebody expects to see in a state field.
      region: "CA",
    });
  });

  it("asks the provider for the right country and code", async () => {
    const fetchImpl = stubFetch(200, BEVERLY_HILLS);
    await lookupPostalCode({ countryCode: "US", postalCode: " 90210 " }, fetchImpl);

    const [url] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("https://api.zippopotam.us/us/90210");
  });

  it("sends only the outward code for the UK", async () => {
    // The real payload, verbatim from api.zippopotam.us/gb/EC1A.
    const fetchImpl = stubFetch(200, {
      country: "Great Britain",
      "post code": "EC1A",
      places: [
        { "place name": "London", state: "England", "state abbreviation": "ENG" },
      ],
    });

    const place = await lookupPostalCode(
      { countryCode: "gb", postalCode: "ec1a 1bb" },
      fetchImpl,
    );

    // The full postcode resolves to nothing at this provider, which would
    // surface as "no place matched" for a perfectly valid address.
    const [url] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("https://api.zippopotam.us/gb/EC1A");
    expect(place.city).toBe("London");
    // "England", not the provider's "ENG" — nobody writes their address that
    // way, and the field is labelled "State or region".
    expect(place.region).toBe("England");
  });

  it("writes the region the way the country writes it", async () => {
    // Berlin comes back as "BE", which is not how a German address is
    // written. Only US, Canadian, and Australian regions prefer the code.
    const german = stubFetch(200, {
      places: [
        { "place name": "Berlin", state: "Berlin", "state abbreviation": "BE" },
      ],
    });
    const berlin = await lookupPostalCode(
      { countryCode: "de", postalCode: "10115" },
      german,
    );
    expect(berlin.region).toBe("Berlin");

    const american = stubFetch(200, BEVERLY_HILLS);
    const beverlyHills = await lookupPostalCode(
      { countryCode: "us", postalCode: "90210" },
      american,
    );
    expect(beverlyHills.region).toBe("CA");
  });

  it("falls back to the other form when a country's preferred one is missing", async () => {
    const fetchImpl = stubFetch(200, {
      places: [{ "place name": "Somewhere", state: "Full Name Only" }],
    });

    const place = await lookupPostalCode(
      { countryCode: "us", postalCode: "12345" },
      fetchImpl,
    );

    expect(place.region).toBe("Full Name Only");
  });

  it("sends only the forward sortation area for Canada", async () => {
    const fetchImpl = stubFetch(200, {
      places: [{ "place name": "Toronto", "state abbreviation": "ON" }],
    });

    await lookupPostalCode({ countryCode: "ca", postalCode: "M5V3L9" }, fetchImpl);

    const [url] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("https://api.zippopotam.us/ca/M5V");
  });

  it("refuses a country it cannot resolve, without spending a request", async () => {
    const fetchImpl = stubFetch(200, BEVERLY_HILLS);

    await expect(
      lookupPostalCode({ countryCode: "ie", postalCode: "D02 XY45" }, fetchImpl),
    ).rejects.toMatchObject({ code: "unsupported_country" });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects anything that could not be a postal code before building a URL", async () => {
    const fetchImpl = stubFetch(200, BEVERLY_HILLS);

    // Path traversal is the case that matters: the code is interpolated into a
    // path segment, so it is validated against an allowlist and not merely
    // encoded.
    for (const postalCode of ["../../admin", "90210?x=1", "9", "a".repeat(20)]) {
      await expect(
        lookupPostalCode({ countryCode: "us", postalCode }, fetchImpl),
      ).rejects.toMatchObject({ code: "invalid_postal_code" });
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a 404 as an answer, not a fault", async () => {
    const fetchImpl = stubFetch(404, {});

    await expect(
      lookupPostalCode({ countryCode: "us", postalCode: "00000" }, fetchImpl),
    ).rejects.toMatchObject({
      code: "not_found",
      message: POSTAL_LOOKUP_MESSAGES.not_found,
    });
  });

  it("treats a 200 with no places as a miss rather than a crash", async () => {
    const fetchImpl = stubFetch(200, { "post code": "12345", places: [] });

    await expect(
      lookupPostalCode({ countryCode: "us", postalCode: "12345" }, fetchImpl),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports a rate limit as its own thing, so the message can say 'try again'", async () => {
    const fetchImpl = stubFetch(429, {});

    await expect(
      lookupPostalCode({ countryCode: "us", postalCode: "90210" }, fetchImpl),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("does not crash on a payload it cannot read", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    }) as unknown as typeof fetch;

    await expect(
      lookupPostalCode({ countryCode: "us", postalCode: "90210" }, fetchImpl),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("turns a transport failure into Lia's own sentence", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.zippopotam.us"));

    const error = await lookupPostalCode(
      { countryCode: "us", postalCode: "90210" },
      fetchImpl as unknown as typeof fetch,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PostalLookupError);
    // The provider's — or Node's — own words never reach the person.
    expect((error as PostalLookupError).message).toBe(
      POSTAL_LOOKUP_MESSAGES.provider_error,
    );
    expect((error as PostalLookupError).message).not.toContain("ENOTFOUND");
  });

  it("leaves the region empty rather than filling it with a stand-in", async () => {
    // Neither form supplied. The country name is right there in the payload
    // and is exactly the wrong thing to put in a region field.
    const fetchImpl = stubFetch(200, {
      country: "United States",
      places: [{ "place name": "Nowhere In Particular", state: "  " }],
    });

    const place = await lookupPostalCode(
      { countryCode: "us", postalCode: "90210" },
      fetchImpl,
    );

    expect(place.region).toBe("");
  });

  it("has a message for every failure code", () => {
    for (const message of Object.values(POSTAL_LOOKUP_MESSAGES)) {
      expect(message.trim().length).toBeGreaterThan(0);
    }
  });
});
