import { defineStorage } from '@aws-amplify/backend';

/**
 * Private uploads: commission reference photos and children's drawings.
 * Each customer can only reach their own folder; ADMINS can read all of them (and upload, for testing as a customer).
 * Set a 60-day expiry rule on this bucket in the S3 console (see SETUP.md).
 */
export const storage = defineStorage({
  name: 'kalaiUploads',
  access: (allow) => ({
    'uploads/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
      // ADMINS read everything; write too, because a signed-in admin uses the group's role (not the customer's)
      // when testing the site as a customer (enquiry photos, damage photos).
      allow.groups(['ADMINS']).to(['read', 'write']),
    ],
  }),
});
