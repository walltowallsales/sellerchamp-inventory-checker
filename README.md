# SellerChamp Inventory Checker v1.5.0

A separate app branched from Location Mover v2.30. The Location Mover project is unchanged.

## Workflows
- Shelf Check: scan a location and report expected submitted inventory plus unsubmitted Batch listings at that exact location.
- Submitted records are labeled SUBMITTED.
- Unsubmitted Batch records are labeled NOT SUBMITTED.
- Tap a shelf record to open Item Check for that SKU.
- Item Check: scan an item, see expected locations/quantities, directly update quantity or move submitted Product inventory.
- Unsubmitted items do not use unsafe Batch API writes. Their controls open the exact SellerChamp Batch for manual location/quantity changes.
- Uses the fast Products-first lookup learned from Location Mover.
- Quantity editing uses the iPhone numeric keyboard.

## Notes
Shelf Check uses SellerChamp's catalog location-items endpoint for submitted inventory when Catalog Sync is available, and scans SellerChamp manifests for unsubmitted Batch listings. Batch shelf discovery can take longer than normal item lookup.

V1.2 prevents one failed SellerChamp source from cancelling the entire shelf report and disables browser caching so the displayed version updates immediately after a Render deployment.

V1.3 paces SellerChamp requests, automatically retries HTTP 429 responses with increasing delays, limits Batch scanning to current/recent Batches, and briefly caches completed Batch shelf results.

V1.4 adds persistent Shelf Check checkboxes, a completed-item highlight, and a Clear Checks control so a shelf can be verified item by item.

V1.5 keeps the Inventory Checker title on one responsive line to reduce header height on iPhone.
