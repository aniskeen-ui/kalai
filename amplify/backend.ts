import { defineBackend } from '@aws-amplify/backend';
import { Stack } from 'aws-cdk-lib';
import { Policy, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { StartingPosition, EventSourceMapping } from 'aws-cdk-lib/aws-lambda';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { zohoQuoteSync } from './functions/zoho-quote-sync/resource';

const backend = defineBackend({
  auth,
  data,
  storage,
  zohoQuoteSync,
});

// Send every new enquiry to Zoho Books as a quote.
const enquiryTable = backend.data.resources.tables['Enquiry'];

const streamPolicy = new Policy(Stack.of(enquiryTable), 'ZohoQuoteSyncStreamPolicy', {
  statements: [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams'],
      resources: [enquiryTable.tableStreamArn!],
    }),
  ],
});
backend.zohoQuoteSync.resources.lambda.role?.attachInlinePolicy(streamPolicy);

const mapping = new EventSourceMapping(Stack.of(enquiryTable), 'ZohoQuoteSyncEnquiryStream', {
  target: backend.zohoQuoteSync.resources.lambda,
  eventSourceArn: enquiryTable.tableStreamArn,
  startingPosition: StartingPosition.LATEST,
  batchSize: 10,
  retryAttempts: 3,
  reportBatchItemFailures: true,
});
mapping.node.addDependency(streamPolicy);
