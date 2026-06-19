import React, { useEffect, useState } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { RotateCcw, Trophy } from 'lucide-react';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

const colors = [
  '#4f46e5', // primary
  '#ec4899', // secondary
  '#10b981', // success
  '#f59e0b', // warning
  '#ef4444', // danger
  '#8b5cf6', // purple
  '#06b6d4', // cyan
];

export default function EndScreen({ game, theme, mode, deviceId, setMode }) {
  const { 
    winner, 
    round, 
    formattedTime, 
    sortedPlayers, 
    startGame, 
    endGame,
    chartLabels,
    chartNames,
    chartValues,
    leaveRoom
  } = game;

  const [deviceStats, setDeviceStats] = useState(null);

  useEffect(() => {
    if (mode === 'online' && deviceId) {
      fetch(`/api/stats/${deviceId}`)
        .then(res => res.json())
        .then(data => setDeviceStats(data))
        .catch(err => console.error("Could not fetch device stats", err));
    }
  }, [mode, deviceId]);

  if (!winner) return null;

  const textColor = theme === 'dark' ? '#f8fafc' : '#1a1a1a';
  const gridColor = theme === 'dark' ? '#334155' : '#e5e7eb';

  const chartData = {
    labels: chartLabels,
    datasets: chartNames.map((name, i) => ({
      label: name,
      data: chartValues[i],
      borderColor: colors[i % colors.length],
      backgroundColor: colors[i % colors.length],
      tension: 0.2
    }))
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { color: textColor } },
      title: { display: true, text: 'Score per Round', color: textColor },
    },
    scales: {
      y: { ticks: { color: textColor }, grid: { color: gridColor } },
      x: { ticks: { color: textColor }, grid: { color: gridColor } }
    }
  };

  return (
    <div className="container" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div className="glass-card" style={{ textAlign: 'center' }}>
        <Trophy size={64} color="var(--primary)" style={{ margin: '0 auto', marginBottom: '1rem' }} />
        <h1 style={{ marginBottom: '1rem' }}>Winner: {winner.name}</h1>
        
        <div className="flex-center" style={{ marginBottom: '2rem' }}>
          <div className="stat-box" style={{ minWidth: '150px' }}>
            <div className="label">Played Rounds</div>
            <div className="value">{round}</div>
          </div>
          <div className="stat-box" style={{ minWidth: '150px' }}>
            <div className="label">Playtime</div>
            <div className="value">{formattedTime}</div>
          </div>
        </div>

        <div className="flex-center">
          {(!game.isOnline || game.isHost) ? (
            <>
              <button className="btn btn-primary" onClick={startGame}>
                <RotateCcw /> Play Again
              </button>
              <button className="btn btn-outline" onClick={endGame}>
                New Game Config
              </button>
            </>
          ) : (
            <div className="flex-center" style={{ flexDirection: 'column', gap: '1rem' }}>
              <div style={{ color: 'var(--primary)', fontWeight: 'bold' }}>
                Waiting for host to restart...
              </div>
              <button className="btn btn-outline" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={leaveRoom}>
                Leave Game
              </button>
            </div>
          )}
        </div>
      </div>

      {deviceStats && deviceStats.gamesPlayed > 0 && (
        <div className="glass-card">
          <h3 style={{ textAlign: 'center', marginBottom: '1.5rem' }}>Your Lifetime Statistics</h3>
          <div className="flex-between" style={{ justifyContent: 'space-around', textAlign: 'center' }}>
            <div>
              <div style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--primary)' }}>{deviceStats.gamesPlayed}</div>
              <div style={{ fontSize: '0.85rem', opacity: 0.8 }}>Games Played</div>
            </div>
            <div>
              <div style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--success)' }}>{deviceStats.wins}</div>
              <div style={{ fontSize: '0.85rem', opacity: 0.8 }}>Total Wins</div>
            </div>
            <div>
              <div style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--danger)' }}>{deviceStats.pointsDeducted}</div>
              <div style={{ fontSize: '0.85rem', opacity: 0.8 }}>-1000 Points Eaten</div>
            </div>
            <div>
              <div style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--secondary)' }}>{deviceStats.kniffelCompleted}</div>
              <div style={{ fontSize: '0.85rem', opacity: 0.8 }}>Kniffels Completed</div>
            </div>
          </div>
        </div>
      )}

      <div className="glass-card">
        <h3>Game Statistics</h3>
        <div className="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Stat</th>
                {sortedPlayers.map(p => <th key={p.name}>{p.name}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Position</td>
                {sortedPlayers.map(p => <td key={p.name}>{p.position}.</td>)}
              </tr>
              <tr>
                <td>Score</td>
                {sortedPlayers.map(p => <td key={p.name} style={{ fontWeight: 600 }}>{p.score}</td>)}
              </tr>
              <tr>
                <td>Total Turns</td>
                {sortedPlayers.map(p => <td key={p.name}>{p.totalTurns}</td>)}
              </tr>
              <tr>
                <td>Busts</td>
                {sortedPlayers.map(p => <td key={p.name}>{p.busts}</td>)}
              </tr>
              <tr>
                <td>Avg Pts / Round</td>
                {sortedPlayers.map(p => <td key={p.name}>{Math.round(p.score / Math.max(1, round))}</td>)}
              </tr>
              <tr>
                <td>-1000 Points</td>
                {sortedPlayers.map(p => <td key={p.name}>{p.times1000PointsDeducted}</td>)}
              </tr>
              <tr>
                <td>Plus/Minus (Success/Fail)</td>
                {sortedPlayers.map(p => <td key={p.name}>{p.timesPlusMinusCompleted} / {p.timesPlusMinusFailed}</td>)}
              </tr>
              <tr>
                <td>Kniffel (Success/Fail)</td>
                {sortedPlayers.map(p => <td key={p.name}>{p.timesKniffelCompleted} / {p.timesKniffelFailed}</td>)}
              </tr>
              <tr>
                <td>Skipped</td>
                {sortedPlayers.map(p => <td key={p.name}>{p.timesSkipped}</td>)}
              </tr>
              <tr>
                <td>Feuerwerk (Received / Pts)</td>
                {sortedPlayers.map(p => <td key={p.name}>{p.timesFeuerwerkReceived} / {p.feuerwerkPointsScored || 0}</td>)}
              </tr>
              <tr>
                <td>Kleeblatt (Fail)</td>
                {sortedPlayers.map(p => <td key={p.name}>{p.timesKleeblattFailed}</td>)}
              </tr>
              <tr>
                <td>x2 (Received / Pts)</td>
                {sortedPlayers.map(p => <td key={p.name}>{p.timesx2Received} / {p.x2PointsScored || 0}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="glass-card" style={{ height: '400px' }}>
        <Line data={chartData} options={chartOptions} />
      </div>
    </div>
  );
}
