import { defineStorage } from '@aws-amplify/backend';

/**
 * Private uploads: commission reference photos and children's drawings.
 * Each customer can only reach their own folder; ADMINS can read all of them.
 * Set a 60-day expiry rule on this bucket in the S3 console (see SETUP.md).
 */
export const storage = defineStorage({
  name: 'kalaiUploads',
  access: (allow) => ({
    'uploads/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
      allow.groups(['ADMINS']).to(['read']),
    ],
  }),
});
