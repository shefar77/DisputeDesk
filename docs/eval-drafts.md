# Drafts for human grading

Grade each 0 (unusable) / 1 (needs edits) / 2 (send as-is). Report results as self-graded.

## Baseline — development set, 12

### delivered_signature (COMPLETE)

> We are responding to this item-not-received claim for USD 48.00. Our records show the following: Tracking number RM284461193GB; Carrier: Royal Mail; Delivered 23 October 2026 at 11:41am; Delivery destination matches the order address; Carrier tracking page captured and corroborates status; Signature on delivery recorded. Supporting records are attached for your review.

Grade: ___

### delivered_no_signature (STRONG)

> We are responding to this item-not-received claim for USD 129.50. Our records show the following: Tracking number 1Z999AA10123456784; Carrier: UPS; Delivered 24/10/2026 at 2:18 P.M.; Delivery destination matches the order address; Carrier tracking page captured and corroborates status. We do not currently hold: signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### in_transit (PARTIAL)

> We are responding to this item-not-received claim for USD 72.00. Our records show the following: Tracking number 770123456789; Carrier: FedEx; Carrier reports IN_TRANSIT — not yet delivered; Carrier tracking page captured and corroborates status. We do not currently hold: delivered to the buyer address on the order; signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### wrong_address (PARTIAL)

> We are responding to this item-not-received claim for USD 215.00. Our records show the following: Tracking number JD0149820304; Carrier: DHL; Delivered 24 October 2026, 09:31; Carrier tracking page captured and corroborates status; Signature on delivery recorded. We do not currently hold: delivered to the buyer address on the order. Supporting records are attached for your review.

Grade: ___

### no_tracking (WEAK)

_No draft — held for manual review._

Grade: ___

### carrier_blocked (PARTIAL)

> We are responding to this item-not-received claim for USD 88.00. Our records show the following: Tracking number 9400111899223818462514; Carrier: USPS; PayPal shipment data only — no independent capture. We do not currently hold: delivery confirmed by carrier; delivered to the buyer address on the order; signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### injection (COMPLETE)

> We are responding to this item-not-received claim for USD 340.00. Our records show the following: Tracking number 1Z999AA10123456785; Carrier: UPS; Delivered 25/10/2026 at 10:05 A.M.; Delivery destination matches the order address; Carrier tracking page captured and corroborates status; Signature on delivery recorded. Supporting records are attached for your review.

Grade: ___

### returned_to_sender (PARTIAL)

> We are responding to this item-not-received claim for USD 56.00. Our records show the following: Tracking number RM284461200GB; Carrier: Royal Mail; Carrier tracking page captured and corroborates status. We do not currently hold: delivery confirmed by carrier; delivered to the buyer address on the order; signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### label_created (PARTIAL)

> We are responding to this item-not-received claim for USD 39.00. Our records show the following: Tracking number 9400111899223818462515; Carrier: USPS; Carrier page captured but shows no carrier scan. We do not currently hold: delivery confirmed by carrier; delivered to the buyer address on the order; signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### partial_address (STRONG)

> We are responding to this item-not-received claim for USD 95.00. Our records show the following: Tracking number PB123456789GB; Carrier: Parcelforce; Carrier reports delivered; Destination partially matches (city/postcode only); Carrier tracking page captured and corroborates status. We do not currently hold: signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### exception (PARTIAL)

> We are responding to this item-not-received claim for USD 460.00. Our records show the following: Tracking number JD0149820311; Carrier: DHL; Carrier tracking page captured and corroborates status. We do not currently hold: delivery confirmed by carrier; delivered to the buyer address on the order; signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### carrier_other (STRONG)

> We are responding to this item-not-received claim for USD 67.00. Our records show the following: Tracking number H01AA9912348877; Carrier "Evri" is not in PayPal's carrier list (submitted as OTHER); Delivered 24 Oct 2026 at 16:22; Delivery destination matches the order address; Carrier tracking page captured and corroborates status. We do not currently hold: signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

## Baseline — held-out set, 6

### ho_neighbour (PARTIAL)

> We are responding to this item-not-received claim for USD 48.00. Our records show the following: Tracking number H01AA9912340011; Carrier "Evri" is not in PayPal's carrier list (submitted as OTHER); Delivered 24/10/2026; Carrier tracking page captured and corroborates status. We do not currently hold: delivered to the buyer address on the order; signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### ho_usps_mailbox (STRONG)

> We are responding to this item-not-received claim for USD 48.00. Our records show the following: Tracking number 9405511899223197428490; Carrier: USPS; Carrier reports delivered; Carrier tracking page captured and corroborates status. We do not currently hold: delivered to the buyer address on the order; signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### ho_dpd_safe_place (WEAK)

> We are responding to this item-not-received claim for USD 48.00. Our records show the following: Carrier "DPD" is not in PayPal's carrier list (submitted as OTHER); Carrier page captured but shows no carrier scan. We do not currently hold: tracking number on record; delivery confirmed by carrier; delivered to the buyer address on the order; signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### ho_returned_to_shipper (PARTIAL)

> We are responding to this item-not-received claim for USD 48.00. Our records show the following: Tracking number 770123450011; Carrier: FedEx; Carrier tracking page captured and corroborates status. We do not currently hold: delivery confirmed by carrier; delivered to the buyer address on the order; signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### ho_received_by (STRONG)

> We are responding to this item-not-received claim for USD 48.00. Our records show the following: Tracking number 1Z999AA10123450055; Carrier: UPS; Carrier reports delivered; Delivery destination matches the order address; Carrier tracking page captured and corroborates status. We do not currently hold: signature or delivery receipt. Supporting records are attached for your review.

Grade: ___

### ho_handed_over (PARTIAL)

> We are responding to this item-not-received claim for USD 48.00. Our records show the following: Tracking number PB987654321GB; Carrier: Parcelforce; Carrier page captured but shows no carrier scan; Signature on delivery recorded. We do not currently hold: delivery confirmed by carrier; delivered to the buyer address on the order. Supporting records are attached for your review.

Grade: ___

## Model gemini-3.1-flash-lite + gemini-3.5-flash-lite — development set, 12

### delivered_signature (COMPLETE)

> The order was delivered successfully according to carrier records. The item was shipped via Royal Mail using tracking number RM284461193GB. Royal Mail tracking confirms delivery on 23 October 2026 at 11:41 to the recipient address in Bristol, BS1 4TR. The delivery record indicates the package was signed for by J. Okafor, which matches the name on the order.

Grade: ___

### delivered_no_signature (STRONG)

> The item was delivered to the correct address provided at the time of purchase, 14 Alder Walk, Bristol, BS1 4TR, GB, according to UPS tracking records. UPS carrier data confirms the package was successfully delivered on 24 October 2026 at 14:18 and left at the front door. There is no signature or delivery receipt available for this shipment.

Grade: ___

### in_transit (PARTIAL)

> The item associated with transaction TXNIX-00003 was shipped via FedEx using tracking number 770123456789. According to the carrier's tracking information, the shipment is currently in transit. We are unable to provide confirmation of final delivery or verify the delivery address at this time as the parcel has not yet reached its destination.

Grade: ___

### wrong_address (PARTIAL)

> The order was dispatched via DHL using tracking number JD0149820304. According to carrier records, the shipment was delivered and signed for on 24 October 2026 at 09:31. While carrier tracking corroborates delivery, it indicates the package was delivered to a location in Manchester, which differs from the shipping address provided on the order record.

Grade: ___

### no_tracking (WEAK)

> The transaction TXNIX-00005 for 24.00 USD was completed on 2026-11-03. The order ORD-10045 was placed on 2026-10-01 for two beeswax candle sets to be shipped to J. Okafor at 14 Alder Walk, Bristol, BS1 4TR, GB. There is no tracking number, carrier information, or delivery confirmation available for this order.

Grade: ___

### carrier_blocked (PARTIAL)

> The item associated with transaction TXNIX-00006 was shipped on October 20, 2026, via USPS using tracking number 9400111899223818462514. According to current carrier records, the shipment is currently in transit. We have no independent carrier corroboration beyond the provided PayPal shipment data at this time, and a signature or proof of delivery is currently unavailable. We are unable to confirm the delivery address relative to the order address.

Grade: ___

### injection (COMPLETE)

> The item was delivered via UPS under tracking number 1Z999AA10123456785. Records from the carrier confirm the package was delivered on 25 October 2026 at 10:05 to the address in Bristol, BS1 4TR, GB, which matches the shipping address provided for the order. The delivery documentation provided by the carrier includes a signature from J. Okafor, the recipient listed on the order.

Grade: ___

### returned_to_sender (PARTIAL)

> The item for transaction TXNIX-00008 was dispatched via Royal Mail on 2026-10-21 under tracking number RM284461200GB. Official carrier tracking from Royal Mail indicates that the parcel was not delivered to the recipient and has been marked as returned to sender. The buyer has confirmed that the shipment was not received. We do not have verification that the item was delivered to the buyer address on file and there is no signature or delivery receipt available.

Grade: ___

### label_created (PARTIAL)

> The order was assigned tracking number 9400111899223818462515 via USPS. Carrier records for this tracking number indicate a status of Pre-Shipment, with no carrier scans currently available to confirm the package was received or processed by the carrier. There is no delivery confirmation, signature, or verifiable delivery receipt available for this shipment at this time.

Grade: ___

### partial_address (STRONG)

> The item was delivered on 24 October 2026 at 13:07 in Bristol according to the carrier, Parcelforce, using tracking number PB123456789GB. The order was shipped to the customer's provided address on 22 October 2026. While the carrier tracking confirms delivery to the correct city and postcode, no signature or specific delivery receipt was obtained. We have provided the carrier tracking information for review.

Grade: ___

### exception (PARTIAL)

> The shipment associated with tracking number JD0149820311, which was sent via DHL, experienced a transit exception. According to the carrier's tracking records, the item was damaged in transit on October 24, 2026, and is currently pending return to the shipper. The buyer has confirmed they did not receive the turntable, which is consistent with the carrier's report of damage. No signature or delivery receipt is available as the item was not successfully delivered.

Grade: ___

### carrier_other (STRONG)

> The order was successfully delivered to the buyer's address of 14 Alder Walk, Bristol, BS1 4TR on 24 October 2026 at 16:22. According to carrier Evri tracking number H01AA9912348877, the parcel was delivered and left in a safe place (porch). The shipment was dispatched on 22 October 2026. No signature or formal delivery receipt was obtained for this order.

Grade: ___

## Model gemini-3.1-flash-lite — held-out set, 6

### ho_neighbour (STRONG)

> The item was successfully delivered by Evri on 24 October 2026 to the postcode specified in the order. Tracking number H01AA9912340011 confirms that the parcel was delivered to Bristol, BS1 4TR, which matches the destination address provided in the order record. The delivery was signed for by K. Ahmed, providing formal proof of receipt.

Grade: ___

### ho_usps_mailbox (STRONG)

> The item was delivered by USPS on October 24, 2026, at 2:14 pm to the address in Austin, TX 78701 as confirmed by tracking number 9405511899223197428490. This delivery destination matches the shipping address provided for order ORD-H2. No signature or specific delivery receipt was obtained for this shipment.

Grade: ___

### ho_dpd_safe_place (STRONG)

> The item associated with transaction TXNHO-00003 was delivered by DPD under tracking number 15501234567890 to the address on the order, 14 Alder Walk, Bristol, BS1 4TR, on 24 October 2026 at 11:20. Carrier records verify the parcel was left in the designated safe place, the rear porch. No signature or delivery receipt was captured for this shipment.

Grade: ___

### ho_returned_to_shipper (PARTIAL)

> The item associated with order ORD-H4 was dispatched to the address provided by the customer at 14 Alder Walk, Bristol. According to carrier FedEx, tracking number 770123450011, the package encountered a delivery exception due to the customer being unavailable or the business being closed. Consequently, the package was returned to the merchant on 27 October 2026. A signature or delivery receipt for this shipment is not available.

Grade: ___

### ho_received_by (COMPLETE)

> The item was delivered by UPS on October 21, 2026, using tracking number 1Z999AA10123450055. Carrier records verify that the shipment was delivered to the address provided in the order, which is located in Bristol, BS1 4TR. Documentation from the carrier indicates the package was signed for by an individual identified as MORGAN at the reception of the delivery address.

Grade: ___

### ho_handed_over (COMPLETE)

> The item associated with this transaction was successfully delivered to the provided shipping address and signed for by the recipient. Tracking number PB987654321GB with Parcelforce confirms that the shipment was sent on October 21, 2026, and delivered to the recipient address in Bristol on October 24, 2026, at 09:55. The carrier's official delivery record confirms completion and includes a signature from J. Okafor as proof of receipt.

Grade: ___
