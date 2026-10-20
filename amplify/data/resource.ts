import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { zohoQuoteSync } from '../functions/zoho-quote-sync/resource';

/**
 * One Enquiry per "Ask for price", commission request or Little Artists gift.
 * Customers can create and read their own enquiries.
 * Price, payment link, status, payment details and the studio message can only be set by ADMINS.
 */
const schema = a.schema({
  Enquiry: a
    .model({
      ref: a.string().required(),
      kind: a.enum(['PRICE', 'COMMISSION', 'GIFT']),
      title: a.string().required(),
      details: a.json(),
      customerName: a.string(),
      phone: a.string(),
      email: a.string(),
      fileKey: a.string(),
      status: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      quotedPrice: a.float().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      paymentLink: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      adminMessage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      paymentMethod: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      paymentRef: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Written by the Zoho sync: what Zoho Books holds for this enquiry (PAID = locked).
      zohoState: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoQuote: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoInvoice: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoInvoiceId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoPaymentId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoMessage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Purchase side (Siva): PO → bill → payment. Set by the Studio desk / written back by the Zoho sync.
      costingAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      artistInvoiceNo: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      artistPaidRef: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      purchaseState: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      purchaseMessage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoPO: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoPOId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoBill: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoBillId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoVendorPaymentId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Delivery: courier + tracking (shown to the customer) and the Zoho delivery challan.
      courierName: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      trackingNo: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoChallan: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoChallanId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      deliveryState: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      deliveryMessage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      owner: a.string().authorization((allow) => [allow.owner().to(['read', 'delete']), allow.group('ADMINS').to(['read'])]),
    })
    .authorization((allow) => [allow.owner().to(['create', 'read']), allow.group('ADMINS')]),

  // Cost build-up per enquiry: Siva's price and the costing. Admin only, never visible to customers.
  // Siva writes his price through artistQuote (below), not directly.
  Costing: a
    .model({
      enquiryId: a.id().required(),
      artistPriceInr: a.float(),
      artistReadyBy: a.string(),
      artistNote: a.string(),
      artistAt: a.string(),
      sizeTier: a.string(),
      delivery: a.string(),
      framingOverride: a.float(),
      indiaCourierOverride: a.float(),
      localCourierOverride: a.float(),
      costs: a.json(),
      // Every Zoho document for the order (quote, invoices, payments, PO, bills), refreshed by Check Zoho.
      zohoDocs: a.json(),
      docsAt: a.string(),
    })
    .identifier(['enquiryId'])
    .authorization((allow) => [allow.group('ADMINS')]),

  // Master rates (framing and India courier per size tier, local courier, customs, fee, margin, VAT, FX).
  Rates: a
    .model({
      key: a.id().required(),
      data: a.json(),
    })
    .identifier(['key'])
    .authorization((allow) => [allow.group('ADMINS')]),

  // Artist desk: Siva's list (no customer details, no selling price), his price, and commission photos.
  artistList: a
    .query()
    .returns(a.string())
    .authorization((allow) => [allow.group('ARTISTS'), allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),
  artistQuote: a
    .mutation()
    .arguments({ id: a.id().required(), priceInr: a.float().required(), readyBy: a.string(), note: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ARTISTS'), allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),
  artistPhoto: a
    .query()
    .arguments({ id: a.id().required() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ARTISTS'), allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),

  // Studio desk "Check Zoho": re-reads the invoice in Zoho; unlocks the enquiry if it was voided or its payment removed.
  checkZoho: a
    .mutation()
    .arguments({ id: a.id().required() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
