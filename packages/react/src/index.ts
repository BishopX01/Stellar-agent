'use client';

// Core SDK types re-exported directly from marc-stellar-sdk.
export type { Agent, Job, JobStatus, MarcConfig } from 'marc-stellar-sdk';

// Shared async state type.
export type { AsyncState } from './hooks/useAsync';

// Hooks and their option/result interfaces.
export { useAgent } from './hooks/useAgent';
export type { UseAgentOptions, UseAgentResult } from './hooks/useAgent';

export { useJob } from './hooks/useJob';
export type { UseJobOptions, UseJobResult } from './hooks/useJob';

export { useCreateJob } from './hooks/useCreateJob';
export type { UseCreateJobResult } from './hooks/useCreateJob';

export { useCommerce } from './hooks/useCommerce';
export type { UseCommerceResult } from './hooks/useCommerce';

export { useWallet } from './hooks/useWallet';
export type { UseWalletOptions, UseWalletResult } from './hooks/useWallet';

// Component prop interfaces.
export type { AgentCardProps } from './components/AgentCard';
export type { JobStatusBadgeProps } from './components/JobStatusBadge';
export type { EscrowStepperProps } from './components/EscrowStepper';

// Wallet connect button component and its props.
export { WalletConnectButton } from './components/WalletConnectButton';
export type { WalletConnectButtonProps } from './components/WalletConnectButton';