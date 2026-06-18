import React, { useState, useEffect } from 'react';
import { ArrowLeft, Trophy, Clock, XCircle, Star, BarChart2, Globe, User } from 'lucide-react';

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

  const getDerivedPersonal = (stats) => {
    if (!stats || !stats.gamesPlayed) return null;
    const winRate = ((stats.wins / stats.gamesPlayed) * 100).toFixed(1);
    const avgDuration = stats.totalPlaytime / stats.gamesPlayed;
    
    const cardCounts = {
      "Plus/Minus": (stats.plusMinusCompleted || 0) + (stats.plusMinusFailed || 0),
      "Kniffel": (stats.kniffelCompleted || 0) + (stats.kniffelFailed || 0),
      "Stop": stats.skipped || 0,
      "Feuerwerk": stats.feuerwerkReceived || 0,
      "Kleeblatt": stats.kleeblattFailed || 0,
      "x2": stats.x2Received || 0
    };
    
    let mostPicked = "None";
    let maxCount = 0;
    Object.entries(cardCounts).forEach(([card, count]) => {
      if (count > maxCount) {
        maxCount = count;
        mostPicked = card;
      }
    });

    return { winRate, avgDuration, mostPicked, maxCount };
  };

  const getDerivedGlobal = (stats) => {
    if (!stats || !stats.totalGamesPlayed) return null;
    const avgDuration = stats.totalPlaytime / stats.totalGamesPlayed;
    
    const cardCounts = {
      "Plus/Minus": stats.totalPlusMinus || 0,
      "Kniffel": stats.totalKniffel || 0,
      "Stop": stats.totalStop || 0,
      "Feuerwerk": stats.totalFeuerwerk || 0,
      "Kleeblatt": stats.totalKleeblatt || 0,
      "x2": stats.totalx2 || 0
    };
    
    let mostPicked = "None";
    let maxCount = 0;
    Object.entries(cardCounts).forEach(([card, count]) => {
      if (count > maxCount) {
        maxCount = count;
        mostPicked = card;
      }
    });

    return { avgDuration, mostPicked, maxCount };
  };

  if (loading) {
    return (
      <div className="container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <h2 style={{ color: 'var(--text-color)' }}>Loading Statistics...</h2>
      </div>
    );
  }

  const pDerived = getDerivedPersonal(personalStats);
  const gDerived = getDerivedGlobal(globalStats);

  return (
    <div className="container">
      <div className="glass-card" style={{ maxWidth: '800px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
          <button className="btn btn-outline" onClick={onBack} style={{ padding: '0.5rem', marginRight: '1rem' }}>
            <ArrowLeft size={20} />
          </button>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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
            
            {!personalStats || personalStats.gamesPlayed === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>You haven't played any online games on this device yet!</p>
            ) : (
              <>
                <div className="grid-cols-2" style={{ marginBottom: '1.5rem' }}>
                  <div className="stat-box" style={{ background: 'var(--bg-color)', padding: '1.5rem', borderRadius: '12px', textAlign: 'center' }}>
                    <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: 'var(--primary)' }}>{personalStats.gamesPlayed}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Games Played</div>
                  </div>
                  <div className="stat-box" style={{ background: 'var(--bg-color)', padding: '1.5rem', borderRadius: '12px', textAlign: 'center' }}>
                    <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: 'var(--success)' }}>{personalStats.wins}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Games Won</div>
                  </div>
                </div>

                <div className="grid-cols-2" style={{ marginBottom: '1.5rem' }}>
                  <div className="stat-box" style={{ background: 'var(--bg-color)', padding: '1.5rem', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <Trophy size={32} color="gold" />
                    <div>
                      <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{pDerived.winRate}%</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Win Rate</div>
                    </div>
                  </div>
                  <div className="stat-box" style={{ background: 'var(--bg-color)', padding: '1.5rem', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <Clock size={32} color="var(--primary)" />
                    <div>
                      <div style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>{formatTime(pDerived.avgDuration)}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Average Duration</div>
                    </div>
                  </div>
                </div>

                <div className="grid-cols-2">
                  <div className="stat-box" style={{ background: 'var(--bg-color)', padding: '1.5rem', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <Star size={32} color="var(--warning)" />
                    <div>
                      <div style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>{pDerived.mostPicked}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Most Drawn Special Card ({pDerived.maxCount}x)</div>
                    </div>
                  </div>
                  <div className="stat-box" style={{ background: 'var(--bg-color)', padding: '1.5rem', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <XCircle size={32} color="var(--danger)" />
                    <div>
                      <div style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>{personalStats.pointsDeducted}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Times 1000 Points Deducted</div>
                    </div>
                  </div>
                </div>
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
            
            {!globalStats || globalStats.totalGamesPlayed === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No games have been played on the server yet!</p>
            ) : (
              <>
                <div className="grid-cols-2" style={{ marginBottom: '1.5rem' }}>
                  <div className="stat-box" style={{ background: 'var(--bg-color)', padding: '1.5rem', borderRadius: '12px', textAlign: 'center' }}>
                    <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: 'var(--primary)' }}>{globalStats.totalGamesPlayed}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Total Games Played</div>
                  </div>
                  <div className="stat-box" style={{ background: 'var(--bg-color)', padding: '1.5rem', borderRadius: '12px', textAlign: 'center' }}>
                    <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: 'var(--primary)' }}>{formatTime(globalStats.totalPlaytime)}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Total Time Played</div>
                  </div>
                </div>

                <div className="grid-cols-2">
                  <div className="stat-box" style={{ background: 'var(--bg-color)', padding: '1.5rem', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <Clock size={32} color="var(--success)" />
                    <div>
                      <div style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>{formatTime(gDerived.avgDuration)}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Average Game Duration</div>
                    </div>
                  </div>
                  <div className="stat-box" style={{ background: 'var(--bg-color)', padding: '1.5rem', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <Star size={32} color="var(--warning)" />
                    <div>
                      <div style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>{gDerived.mostPicked}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Most Drawn Card ({gDerived.maxCount}x)</div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
