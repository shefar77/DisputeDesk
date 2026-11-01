/**
 * Policy corpus used to ground plans and drafts.
 *
 * These are OUR notes, written from PayPal's public developer documentation and
 * linked to the page each note came from. They are paraphrases for retrieval, not
 * quotations of PayPal policy, and the UI labels them that way. Where a note is
 * our own inference rather than something a page states, it says so.
 *
 * Kept deliberately small and specific to P0 (Item Not Received). A larger corpus
 * would retrieve more but ground less.
 */

export interface PolicyDoc {
  id: string;
  reason: string | null;
  title: string;
  url: string;
  body: string;
  tags: string[];
}

const DISPUTES_API = 'https://developer.paypal.com/api/customer-disputes/v1';
const USE_DISPUTES = 'https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api';
const REASONS = 'https://developer.paypal.com/platforms/disputes/reference/dispute-reasons';
const FILES = 'https://developer.paypal.com/growth/disputes/reference/supported-file-types-sizes';
const SCHEMA = 'https://developer.paypal.com/api/customer-disputes/v1/schema.json';

export const POLICY_DOCS: PolicyDoc[] = [
  {
    id: 'POL-INR-1',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    title: 'Item not received: proof of fulfilment carries the tracking number',
    url: SCHEMA,
    body:
      'For an item-not-received dispute the merchant responds with proof of fulfilment. In the provide-evidence ' +
      'request, evidence_info with tracking_info (carrier_name and tracking_number) is expected for the ' +
      'PROOF_OF_FULFILLMENT evidence type. Other evidence types carry documents and notes instead.',
    tags: ['tracking', 'proof of fulfilment', 'evidence_info', 'carrier', 'item not received'],
  },
  {
    id: 'POL-INR-2',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    title: 'Item not received: a delivered scan is the core rebuttal',
    url: REASONS,
    body:
      'Our note: the buyer says the item never arrived, so the most relevant evidence is carrier confirmation ' +
      'that it was delivered, ideally to the address on the order. Shipping a parcel is not the same as ' +
      'delivering it; a label or a ship date alone does not rebut the claim.',
    tags: ['delivered', 'delivery confirmation', 'address', 'item not received'],
  },
  {
    id: 'POL-INR-3',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    title: 'Delivery to a different address weakens the response',
    url: REASONS,
    body:
      'Our note (inference): carrier confirmation of delivery to an address that differs from the ship-to ' +
      'address on the order does not show the buyer received the item. Say so plainly rather than presenting ' +
      'the delivered scan as decisive.',
    tags: ['address mismatch', 'delivered', 'wrong address'],
  },
  {
    id: 'POL-INR-4',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    title: 'Signature on delivery strengthens proof of receipt',
    url: SCHEMA,
    body:
      'PROOF_OF_DELIVERY_SIGNATURE is a distinct evidence type in the Disputes API. A signature confirmation ' +
      'removes the argument that the parcel was left somewhere the buyer could not reach it.',
    tags: ['signature', 'proof of delivery', 'signed for'],
  },
  {
    id: 'POL-GEN-1',
    reason: null,
    title: 'Respond before seller_response_due_date',
    url: USE_DISPUTES,
    body:
      'Each dispute exposes seller_response_due_date. Evidence can be provided while the dispute is in ' +
      'WAITING_FOR_SELLER_RESPONSE status. Submitting before the deadline matters more than submitting a perfect ' +
      'package after it.',
    tags: ['deadline', 'seller_response_due_date', 'waiting for seller response'],
  },
  {
    id: 'POL-GEN-2',
    reason: null,
    title: 'Only actions present in the HATEOAS links are available',
    url: DISPUTES_API,
    body:
      'The dispute details response carries links to the actions currently allowed. If the provide-evidence ' +
      'link is not present, evidence cannot be provided for that dispute at this stage. Use only the actions ' +
      'the links offer.',
    tags: ['links', 'hateoas', 'allowed actions', 'provide-evidence'],
  },
  {
    id: 'POL-GEN-3',
    reason: null,
    title: 'Evidence notes are limited to 2,000 characters',
    url: SCHEMA,
    body:
      'The notes field on an evidence object has a maximum length of 2000 characters. Lead with the strongest ' +
      'fact; a reviewer reads a short factual note faster than a long argument.',
    tags: ['notes', 'length', 'draft'],
  },
  {
    id: 'POL-GEN-4',
    reason: null,
    title: 'Supported document types and sizes',
    url: FILES,
    body:
      'PayPal publishes the document formats and size limits accepted with dispute evidence. DisputeDesk ' +
      'accepts PDF, JPEG, PNG, GIF and TIFF up to 10 MB per file and refuses anything else before it reaches ' +
      'PayPal. Document names must match PayPal\'s naming pattern.',
    tags: ['documents', 'upload', 'file size', 'pdf'],
  },
  {
    id: 'POL-GEN-5',
    reason: null,
    title: 'Offers and accepting the claim move money',
    url: USE_DISPUTES,
    body:
      'make-offer proposes a refund or replacement; accept-claim concedes the dispute. Both are financial ' +
      'decisions. Where evidence is weak, a partial offer may cost less than losing the full disputed amount — ' +
      'that is the merchant\'s judgement, not the tool\'s.',
    tags: ['make offer', 'accept claim', 'refund', 'weak evidence'],
  },
  {
    id: 'POL-INR-5',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    title: 'Returned-to-sender and carrier exceptions',
    url: REASONS,
    body:
      'Our note (inference): when the carrier shows the parcel was returned to sender or lost or damaged in ' +
      'transit, the buyer did not receive it. Arguing delivery would be inaccurate; consider a refund, a ' +
      'reshipment offer, or a factual message instead.',
    tags: ['returned to sender', 'exception', 'damaged', 'lost'],
  },
];
