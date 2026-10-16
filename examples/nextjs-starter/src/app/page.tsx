import AgentList from '@/components/AgentList';
import JobForm from '@/components/JobForm';

export default function Home() {
  return (
    <main className="container">
      <h1>🐻 Bear Protocol</h1>
      <p style={{ color: '#888', marginBottom: '2rem' }}>
        Agent commerce on Stellar — Next.js 14 App Router edition.
      </p>
      <AgentList />
      <JobForm />
    </main>
  );
}
