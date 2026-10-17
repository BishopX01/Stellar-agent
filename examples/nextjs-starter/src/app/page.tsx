'use client';

import AgentList from '@/components/AgentList';
import JobForm from '@/components/JobForm';
import { WalletConnectButton } from '@marc-stellar/react';

export default function Home() {
  return (
    <main className="container">
      <h1>🐻 Bear Protocol</h1>
      <p style={{ color: '#888', marginBottom: '2rem' }}>
        Agent commerce on Stellar — Next.js 14 App Router edition.
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1.5rem' }}>
        <WalletConnectButton
          onConnect={(address) => {
            console.log('Connected wallet:', address);
          }}
        />
      </div>
      <AgentList />
      <JobForm />
    </main>
  );
}