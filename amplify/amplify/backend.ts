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

// Let the sync write Zoho's result back onto the enquiry, and read the VAT switch (/kalai/zoho/vat_tax_id).
backend.zohoQuoteSync.addEnvironment('ENQUIRY_TABLE', enquiryTable.tableName);
enquiryTable.grantReadWriteData(backend.zohoQuoteSync.resources.lambda);

// Costing (Siva's price, cost build-up) for the PO, and commission photos for the Artist desk.
const costingTable = backend.data.resources.tables['Costing'];
backend.zohoQuoteSync.addEnvironment('COSTING_TABLE', costingTable.tableName);
costingTable.grantReadWriteData(backend.zohoQuoteSync.resources.lambda);
backend.zohoQuoteSync.addEnvironment('UPLOADS_BUCKET', backend.storage.resources.bucket.bucketName);
backend.storage.resources.bucket.grantRead(backend.zohoQuoteSync.resources.lambda, 'uploads/*');
backend.zohoQuoteSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['ssm:GetParameter'],
    resources: [`arn:aws:ssm:${Stack.of(enquiryTable).region}:${Stack.of(enquiryTable).account}:parameter/kalai/zoho/*`],
  }),
);
