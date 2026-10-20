// Runs before any module is loaded, after dotenv/config.
// Test jobs go to a queue the dev worker does not consume.
process.env.VIDEO_QUEUE_NAME = `${process.env.VIDEO_QUEUE_NAME ?? 'video-processing'}-test`;
// Real-infra tests follow signed URLs from the test process, so sign with the internal host.
process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
