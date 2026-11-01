# Gate G0 — PayPal sandbox spike

PRD §12 defines gate G0: confirm that PayPal's Disputes API behaves the way DisputeDesk assumes before building on it. This file records what has been verified and what has not.

**Summary.** The API *contract* is verified against PayPal's published OpenAPI schema, and the code follows it. The *sandbox behaviour* has not been verified yet. Nobody has filed a sandbox dispute and called the API against it, because that needs a PayPal developer account. Until someone runs steps 1–4 below, the sandbox integration counts as implemented but unverified.

---

## A. Verified: contract extracted from `schema.json` (2026-11-01)

Source: `https://developer.paypal.com/api/customer-disputes/v1/schema.json` (595 KB). I downloaded the file and extracted the values with a script rather than reading them by eye. The values are copied verbatim into `shared/src/paypal-constants.ts`.

| Item | Finding | Where it is used |
|---|---|---|
| `dispute_reason` enum | 10 values, including `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` | rubric selection, UI labels |
| `status` enum | `OPEN`, `WAITING_FOR_BUYER_RESPONSE`, `WAITING_FOR_SELLER_RESPONSE`, `UNDER_REVIEW`, `RESOLVED`, `OTHER` | queue, status badges |
| `dispute_lifecycle_stage` | `INQUIRY`, `CHARGEBACK`, `PRE_ARBITRATION`, `ARBITRATION` | detail header |
| `evidence_type` enum | 86 values. DisputeDesk submits an allow-listed subset of 8 | payload builder |
| **`evidence_info` rule** | Schema text: *"evidence_info is expected for PROOF_OF_FULFILLMENT, PROOF_OF_REFUND and PROOF_OF_RETURN evidence types. documents and notes can be given for rest of the evidence types."* | `buildProvideEvidence` makes any other placement structurally impossible. Covered by a unit test |
| `tracking_info` | `carrier_name` (enum of about 200 regional values, `OTHER` as the catch-all) and `tracking_number` | carrier mapping |
| `notes` | `maxLength` 2000 | clamped in the payload builder. Covered by a unit test |
| `document.name` | pattern `^[A-Za-z0-9-_,\s]+[.]{1}[A-Za-z]+$` | `safeDocumentName`. Outbound names are random and match this pattern |
| `make_offer` | `note` and `offer_type` required. `offer_amount` is `money` | `buildMakeOffer`; amount is capped at the disputed amount |
| `offer_type` | `REFUND`, `REFUND_WITH_RETURN`, `REFUND_WITH_REPLACEMENT`, `REPLACEMENT_WITHOUT_REFUND` | offer form |
| `accept_claim_type` | `REFUND`, `REFUND_WITH_RETURN`, `PARTIAL_REFUND`, `REFUND_WITH_RETURN_SHIPMENT_LABEL` (not the same enum as `offer_type`) | `buildAcceptClaim` |
| HATEOAS | provide-evidence description: *"In case the link is not present in the response, you can't provide evidence for the dispute."* | actions are taken only from `links` (FR-4) |

## B. Gaps found in the published spec

1. **The JSON parts of multipart bodies are not modelled.** For `provide-evidence`, `send-message` and `accept-claim`, the OpenAPI describes only the file part (`evidence-file`, `message_document`, `accept-claim-document`). The JSON parts, `{ evidences: [...] }`, `{ message }` and `{ note, accept_claim_type }`, come from PayPal's prose reference instead. The code marks them `[U-doc]`. Every one of them goes through the approval preview, so a wrong shape surfaces as a visible PayPal 400 with a `debug_id`. It cannot be sent silently by mistake.
2. **Tracker lookup by id needs the tracking number.** `GET /v1/shipping/trackers/{transaction_id}-{tracking_number}` needs the value DisputeDesk is trying to find. The code uses the list form `GET /v1/shipping/trackers?transaction_id=…` instead. Whether this endpoint works for a given sandbox app was flagged `[U]` in the PRD. A 4xx response is treated as "not available" and the workflow falls back.

## C. Not yet done: needs a PayPal developer account

Run these with the Postman collection (`postman/DisputeDesk.postman_collection.json`, folder *PayPal sandbox*, environment `postman/sandbox.postman_environment.json`), then fill in the results table.

1. In the [developer dashboard](https://developer.paypal.com/dashboard/), create a sandbox **business** (seller) account and a **personal** (buyer) account. Create a REST app under the seller, and copy its client id and secret into `.env`.
2. As the buyer, pay the seller (any sandbox checkout). Then, in the buyer's sandbox Resolution Center, open an **Item not received** dispute.
3. Run *OAuth token*, then *List disputes*, then *Show dispute*. Record which `links` rels appear.
4. If `provide-evidence` is present, run *Provide evidence (JSON with tracking)*. Record the HTTP status and `debug_id`. Then try *Send message*.
5. Optional: ask in the [PayPal developer Discord](https://developer.paypal.com/discord) for the `https://uri.paypal.com/services/disputes/create` scope, so disputes can be created by API.
6. Start DisputeDesk with the credentials set. The banner switches from DEMO to SANDBOX. Confirm the dispute appears in the queue and run the approval flow once.

| Step | Result | Date | Notes / debug_id |
|---|---|---|---|
| 1 Accounts and app | not run | | |
| 2 Dispute filed | not run | | |
| 3 Links observed | not run | | |
| 4 provide-evidence | not run | | |
| 4 send-message | not run | | |
| 5 Create scope | not run | | |
| 6 End-to-end in app | not run | | |

**Go / no-go.** The product runs end to end in demo mode now. If step 4 fails for every manually filed dispute, PRD §12 says to discuss fallback C1 (invoice collections) before spending more time. Demo mode stays as the clearly labelled judge path either way.
