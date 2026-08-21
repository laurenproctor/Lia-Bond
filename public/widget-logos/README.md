# Publication logos for the press widget

Every file under this directory is served from Lia's own origin and is the
**only** kind of image the press widget's iframe may load — its content policy
is `img-src 'self' data:` and nothing else. Nothing here is fetched from a
publisher, a favicon service, or a logo API, at render time or at any other
time. The reasoning is in `docs/press-widget.md` §"The logo trust boundary".

## What is bundled today

| Directory | Publication | Registered domain | Provenance | Licence status |
| --- | --- | --- | --- | --- |
| `harbour-ledger/` | The Harbour Ledger | `harbourledger.example` | **Invented.** Original artwork drawn for this repository. | Owned by this project. No third-party rights. |
| `meridian-table/` | Meridian Table | `meridiantable.example` | **Invented.** Original artwork drawn for this repository. | Owned by this project. No third-party rights. |
| `northside-dispatch/` | Northside Dispatch | `northsidedispatch.example` | **Invented.** Original artwork drawn for this repository. | Owned by this project. No third-party rights. |

All three publications are fictional. Their domains sit under `.example`, which
RFC 2606 reserves and which therefore can never collide with an outlet a
customer is genuinely covered by. They exist so the sample on
`/integrations/website-widgets` can be drawn by the real press renderer with
real logo files, without reproducing a trademark this project has no licence to
use and without presenting invented coverage as somebody's real coverage.

**No real publication has a bundled logo.** Real coverage renders the
publisher's name as text, which is a complete rendering of "who published
this". A story is never dropped for want of a mark.

## Adding a real publication

Three steps, no migration, no database write:

1. Obtain the mark and **record the permission** in the table above — the
   publisher's own press or brand-assets page, the licence it is offered under,
   and the date it was retrieved. A logo with no row here is a logo nobody can
   defend.
2. Add `<key>/<key>.v1.svg` and `<key>/<key>-dark.v1.svg`. Optimise them, keep
   them to a 24px design height, and do not recolour a multicolour mark to
   match a palette — ship the publisher's own light and dark variants where
   they provide them.
3. Add a row to `PUBLISHER_LOGOS` in
   `src/lib/widgets/press/publisher-logos.ts`, keyed by the **normalised**
   domain (lowercased, no scheme, no `www.`), with the file's intrinsic width
   and height.

`tests/press-widget-logos.test.ts` fails if an entry names a file that is not
on disk, if a declared dimension disagrees with the file's own `viewBox`, or if
a path escapes this directory.

## File naming

`<key>.v<n>.svg`, and the version is part of the filename rather than a query
string. These files are cached hard by the edge and by browsers; a mark that is
redrawn gets `v2` and a new registry row rather than overwriting `v1`, so a
page that cached the old file is never showing a mark that no longer matches
the one Lia thinks it is serving.
