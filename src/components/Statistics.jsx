import React, { useState, useEffect } from 'react';
import { ArrowLeft, Trophy, Clock, XCircle, Star, BarChart2, Globe, User, TrendingDown, Target, Zap, Hash } from 'lucide-react';

export default function Statistics({ deviceId, onBack }) {
  const [tab, setTab] = useState('personal');
  const [personalStats, setPersonalStats] = useState(null);
  const [globalStats, setGlobalStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        const [personalRes, globalRes] = await Promise.all([
          fetch(`/api/stats/${deviceId}`),
          fetch(`/api/stats/global`)
        ]);
        
        if (personalRes.ok) setPersonalStats(await personalRes.json());
        if (globalRes.ok) setGlobalStats(await globalRes.json());
      } catch (err) {
        console.error("Failed to load statistics:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, [deviceId]);

  const formatTime = (totalSeconds) => {
    if (!totalSeconds || isNaN(totalSeconds)) return "00:00";
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  };

  const getWinLoseRate = (wins, fails) => {
    const total = wins + fails;
    if (total === 0) return "—";
    return `${((wins / total) * 100).toFixed(0)}%`;
  };

  if (loading) {
    return (
      <div className="container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <h2 style={{ color: 'var(--text-color)' }}>Loading Statistics...</h2>
      </div>
    );
  }

  const p = personalStats;
  const g = globalStats;

  const pWinRate = p?.gamesPlayed ? ((p.wins / p.gamesPlayed) * 100).toFixed(1) : "0";
  const pAvgDuration = p?.gamesPlayed ? p.totalPlaytime / p.gamesPlayed : 0;
  const pBustRate = p?.totalTurns ? ((p.busts / p.totalTurns) * 100).toFixed(1) : "0";

  const gAvgDuration = g?.totalGamesPlayed ? g.totalPlaytime / g.totalGamesPlayed : 0;
  const gAvgScorePerTurn = g?.totalTurns ? Math.round(g.totalScore / g.totalTurns) : 0;

  // Card breakdown helper
  const CardRow = ({ label, icon, count, wins, fails, color }) => (
    <div style={{ 
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0.75rem 1rem', borderRadius: '10px',
      background: 'var(--bg-color)', marginBottom: '0.5rem'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1 }}>
        <span style={{ fontSize: '1.25rem' }}>{icon}</span>
        <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
        <div style={{ textAlign: 'center', minWidth: '40px' }}>
          <div style={{ fontWeight: 'bold', fontSize: '1.1rem', color }}>{count}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total</div>
        </div>
        {wins !== undefined && (
          <>
            <div style={{ textAlign: 'center', minWidth: '40px' }}>
              <div style={{ fontWeight: 'bold', fontSize: '1.1rem', color: 'var(--success)' }}>{wins}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Won</div>
            </div>
            <div style={{ textAlign: 'center', minWidth: '40px' }}>
              <div style={{ fontWeight: 'bold', fontSize: '1.1rem', color: 'var(--danger)' }}>{fails}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Lost</div>
            </div>
            <div style={{ textAlign: 'center', minWidth: '50px' }}>
              <div style={{ fontWeight: 'bold', fontSize: '1.1rem', color: 'var(--primary)' }}>
                {getWinLoseRate(wins, fails)}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Rate</div>
            </div>
          </>
        )}
      </div>
    </div>
  );

  // Stat tile helper
  const StatTile = ({ icon, value, label, color = 'var(--primary)' }) => (
    <div className="stat-box" style={{ 
      background: 'var(--bg-color)', padding: '1.25rem', borderRadius: '12px',
      display: 'flex', alignItems: 'center', gap: '0.75rem'
    }}>
      {icon}
      <div>
        <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color }}>{value}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      </div>
    </div>
  );

  // Big stat tile helper
  const BigStatTile = ({ value, label, color = 'var(--primary)' }) => (
    <div className="stat-box" style={{ 
      background: 'var(--bg-color)', padding: '1.5rem', borderRadius: '12px', textAlign: 'center'
    }}>
      <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color }}>{value}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '1px' }}>{label}</div>
    </div>
  );

  return (
    <div className="container">
      <div className="glass-card" style={{ maxWidth: '800px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem', position: 'relative' }}>
          <button className="btn btn-outline" onClick={onBack} style={{ padding: '0.5rem', position: 'absolute', left: 0 }}>
            <ArrowLeft size={20} />
          </button>
          <h1 style={{ margin: '0 auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <BarChart2 size={32} color="var(--primary)" /> Statistics
          </h1>
        </div>

        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', justifyContent: 'center' }}>
          <button className={`btn ${tab === 'personal' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('personal')}>
            <User size={18} /> Personal
          </button>
          <button className={`btn ${tab === 'global' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('global')}>
            <Globe size={18} /> Global Community
          </button>
        </div>

        {tab === 'personal' && (
          <div className="animate-fade-in">
            <h3 style={{ marginBottom: '1.5rem', textAlign: 'center', color: 'var(--text-color)' }}>
              Online Lifetime Record (This Device)
            </h3>
            
            {!p || !p.gamesPlayed ? (
              <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>You haven't played any online games on this device yet!</p>
            ) : (
              <>
                {/* Overview */}
                <div className="grid-cols-2" style={{ marginBottom: '1rem' }}>
                  <BigStatTile value={p.gamesPlayed} label="Games Played" color="var(--primary)" />
                  <BigStatTile value={p.wins} label="Games Won" color="var(--success)" />
                </div>

                <div className="grid-cols-2" style={{ marginBottom: '1rem' }}>
                  <StatTile icon={<Trophy size={28} color="gold" />} value={`${pWinRate}%`} label="Win Rate" color="gold" />
                  <StatTile icon={<Clock size={28} color="var(--primary)" />} value={formatTime(pAvgDuration)} label="Avg Duration" />
                </div>

                <div className="grid-cols-2" style={{ marginBottom: '1.5rem' }}>
                  <StatTile icon={<TrendingDown size={28} color="var(--danger)" />} value={`${pBustRate}%`} label="Bust Rate" color="var(--danger)" />
                  <StatTile icon={<XCircle size={28} color="var(--danger)" />} value={p.pointsDeducted || 0} label="-1000 Pts Eaten" color="var(--danger)" />
                </div>

                <div className="grid-cols-2" style={{ marginBottom: '1.5rem' }}>
                  <StatTile icon={<Hash size={28} color="var(--text-muted)" />} value={p.totalTurns || 0} label="Total Turns" />
                  <StatTile icon={<Clock size={28} color="var(--text-muted)" />} value={formatTime(p.totalPlaytime)} label="Total Playtime" />
                </div>

                {/* Card Breakdown */}
                <h4 style={{ marginBottom: '0.75rem', color: 'var(--text-color)', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                  🃏 Card Breakdown
                </h4>
                <CardRow
                  label="Plus/Minus" icon="±"
                  count={(p.plusMinusCompleted || 0) + (p.plusMinusFailed || 0)}
                  wins={p.plusMinusCompleted || 0} fails={p.plusMinusFailed || 0}
                  color="var(--primary)"
                />
                <CardRow
                  label="Kniffel" icon="🎲"
                  count={(p.kniffelCompleted || 0) + (p.kniffelFailed || 0)}
                  wins={p.kniffelCompleted || 0} fails={p.kniffelFailed || 0}
                  color="var(--secondary)"
                />
                <CardRow
                  label="Kleeblatt" icon="🍀"
                  count={(p.kleeblattCompleted || 0) + (p.kleeblattFailed || 0)}
                  wins={p.kleeblattCompleted || 0} fails={p.kleeblattFailed || 0}
                  color="var(--success)"
                />
                <CardRow label="Stop" icon="🛑" count={p.skipped || 0} color="var(--danger)" />
                <CardRow label="Feuerwerk" icon="🎆" count={p.feuerwerkReceived || 0} color="var(--warning)" />
                <CardRow label="x2" icon="✖️" count={p.x2Received || 0} color="var(--primary)" />
              </>
            )}
          </div>
        )}

        {tab === 'global' && (
          <div className="animate-fade-in">
            <h3 style={{ marginBottom: '1.5rem', textAlign: 'center', color: 'var(--text-color)' }}>
              Global Community Statistics
            </h3>
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', marginBottom: '2rem' }}>Aggregated across all local and online games played.</p>
            
            {!g || !g.totalGamesPlayed ? (
              <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No games have been played on the server yet!</p>
            ) : (
              <>
                {/* Overview */}
                <div className="grid-cols-2" style={{ marginBottom: '1rem' }}>
                  <BigStatTile value={g.totalGamesPlayed} label="Total Games" color="var(--primary)" />
                  <BigStatTile value={formatTime(g.totalPlaytime)} label="Total Playtime" color="var(--primary)" />
                </div>

                <div className="grid-cols-2" style={{ marginBottom: '1.5rem' }}>
                  <StatTile icon={<Clock size={28} color="var(--success)" />} value={formatTime(gAvgDuration)} label="Avg Game Duration" />
                  <StatTile icon={<Target size={28} color="var(--warning)" />} value={gAvgScorePerTurn} label="Avg Score / Turn" color="var(--warning)" />
                </div>

                <div className="grid-cols-2" style={{ marginBottom: '1.5rem' }}>
                  <StatTile icon={<Hash size={28} color="var(--text-muted)" />} value={g.totalTurns || 0} label="Total Turns Played" />
                  <StatTile icon={<Zap size={28} color="var(--primary)" />} value={g.totalScore || 0} label="Total Points Scored" color="var(--primary)" />
                </div>

                {/* Card Breakdown */}
                <h4 style={{ marginBottom: '0.75rem', color: 'var(--text-color)', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                  🃏 Card Breakdown
                </h4>
                <CardRow label="Plus/Minus" icon="±" count={g.totalPlusMinus || 0} color="var(--primary)" />
                <CardRow label="Kniffel" icon="🎲" count={g.totalKniffel || 0} color="var(--secondary)" />
                <CardRow
                  label="Kleeblatt" icon="🍀"
                  count={g.totalKleeblatt || 0}
                  wins={g.totalKleeblattCompleted || 0}
                  fails={(g.totalKleeblatt || 0) - (g.totalKleeblattCompleted || 0)}
                  color="var(--success)"
                />
                <CardRow label="Stop" icon="🛑" count={g.totalStop || 0} color="var(--danger)" />
                <CardRow label="Feuerwerk" icon="🎆" count={g.totalFeuerwerk || 0} color="var(--warning)" />
                <CardRow label="x2" icon="✖️" count={g.totalx2 || 0} color="var(--primary)" />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
