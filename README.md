# SellerChamp Inventory Checker v1.2.0

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
