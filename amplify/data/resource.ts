import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

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
      owner: a.string().authorization((allow) => [allow.owner().to(['read', 'delete']), allow.group('ADMINS').to(['read'])]),
    })
    .authorization((allow) => [allow.owner().to(['create', 'read']), allow.group('ADMINS')]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
