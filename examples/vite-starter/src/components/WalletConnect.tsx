interface Props {
  walletKey: string | null;
  onConnect: (key: string) => void;
}

export default function WalletConnect({ walletKey, onConnect }: Props) {
  function handleInput(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const v = (e.target as HTMLInputElement).value.trim();
      if (v.startsWith('G') && v.length === 56) onConnect(v);
    }
  }

  return (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <strong>Wallet</strong>
      {walletKey ? (
        <p className="addr" style={{ marginTop: '0.5rem' }}>
          ✅ Connected: {walletKey.slice(0, 8)}…{walletKey.slice(-6)}
        </p>
      ) : (
        <>
          <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '0.4rem', marginBottom: '0.5rem' }}>
            Paste your testnet public key (G…) and press Enter to connect.
          </p>
          <input
            placeholder="GABC...XYZ"
            onKeyDown={handleInput}
          />
        </>
      )}
    </div>
  );
}
