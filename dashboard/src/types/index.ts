// Mirrors the on-chain `JobStatus` enum in the agentic-commerce contract.
export type JobStatus =
  | 'Open'
  | 'Funded'
  | 'Submitted'
  | 'Completed'
  | 'Rejected'
  | 'Cancelled'
  | 'Disputed';

export type JobStatusType = JobStatus;
