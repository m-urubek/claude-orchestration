import { useState, useEffect, useRef, useCallback } from 'react';

interface LogEvent {
  type: 'system' | 'agent';
  level?: 'info' | 'success' | 'warn' | 'error' | 'phase' | 'debug';
  agent?: string;
  invocationId?: string;
  message: string;
  timestamp: string;
}

interface PipelineStatus {
  state: {
    phase: string;
    mode: string;
    projectDir: string;
    completedAssignments: string[];
    currentAssignmentId: string | null;
  } | null;
  pauseRequested: boolean;
  hardStopRequested: boolean;
}

interface StartFormData {
  task: string;
  projectDir: string;
  mode: 'autonomous' | 'interactive';
  stopAfterPrd: boolean;
}

function App() {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [showStartForm, setShowStartForm] = useState(false);
  const [formData, setFormData] = useState<StartFormData>({
    task: '',
    projectDir: '',
    mode: 'autonomous',
    stopAfterPrd: false,
  });
  const consoleRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Fetch initial status
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.error('Failed to fetch status:', err);
    }
  }, []);

  // SSE connection
  useEffect(() => {
    const eventSource = new EventSource('/api/stream');

    eventSource.onopen = () => {
      setConnected(true);
    };

    eventSource.onmessage = (event) => {
      try {
        const logEvent: LogEvent = JSON.parse(event.data);
        setLogs((prev) => [...prev, logEvent]);
      } catch (err) {
        console.error('Failed to parse SSE message:', err);
      }
    };

    eventSource.onerror = () => {
      setConnected(false);
      // Attempt to reconnect after 3 seconds
      setTimeout(() => {
        eventSource.close();
      }, 3000);
    };

    fetchStatus();

    return () => {
      eventSource.close();
    };
  }, [fetchStatus]);

  // Auto-scroll console
  useEffect(() => {
    if (autoScrollRef.current && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs]);

  // Handle scroll to detect if user scrolled up
  const handleScroll = () => {
    if (consoleRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = consoleRef.current;
      autoScrollRef.current = scrollTop + clientHeight >= scrollHeight - 50;
    }
  };

  // Control actions
  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      setShowStartForm(false);
      fetchStatus();
    } catch (err) {
      console.error('Failed to start pipeline:', err);
    }
  };

  const handleResume = async () => {
    try {
      await fetch('/api/resume', { method: 'POST' });
      fetchStatus();
    } catch (err) {
      console.error('Failed to resume:', err);
    }
  };

  const handlePause = async () => {
    try {
      await fetch('/api/pause', { method: 'POST' });
      fetchStatus();
    } catch (err) {
      console.error('Failed to pause:', err);
    }
  };

  const handleStop = async () => {
    try {
      await fetch('/api/stop', { method: 'POST' });
      fetchStatus();
    } catch (err) {
      console.error('Failed to stop:', err);
    }
  };

  const handleReset = async () => {
    if (!confirm('Are you sure you want to clear all pipeline state?')) {
      return;
    }
    try {
      await fetch('/api/reset', { method: 'POST' });
      setLogs([]);
      fetchStatus();
    } catch (err) {
      console.error('Failed to reset:', err);
    }
  };

  const handleOpenLogs = async () => {
    try {
      await fetch('/api/open-logs');
    } catch (err) {
      console.error('Failed to open logs:', err);
    }
  };

  const clearConsole = () => {
    setLogs([]);
  };

  const getLevelClass = (event: LogEvent): string => {
    if (event.type === 'agent') return 'log-agent';
    return `log-${event.level || 'info'}`;
  };

  const formatMessage = (event: LogEvent): string => {
    const time = event.timestamp.slice(11, 19);
    if (event.type === 'agent') {
      return `[${time}] [${event.agent}] ${event.message}`;
    }
    const label = {
      info: 'INFO',
      success: ' OK ',
      warn: 'WARN',
      error: 'ERR ',
      phase: '>>>>',
      debug: 'DBG ',
    }[event.level || 'info'];
    return `[${time}] ${label} ${event.message}`;
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Pipeline Monitor</h1>
        <div className="status">
          <span className={`connection-dot ${connected ? 'connected' : 'disconnected'}`} />
          {connected ? 'Connected' : 'Disconnected'}
          {status?.state && (
            <span className="phase-badge">{status.state.phase}</span>
          )}
        </div>
      </header>

      <div className="controls">
        <button onClick={() => setShowStartForm(true)} className="btn btn-primary">
          Start
        </button>
        <button onClick={handleResume} className="btn btn-secondary">
          Resume
        </button>
        <button onClick={handlePause} className="btn btn-warning">
          Pause
        </button>
        <button onClick={handleStop} className="btn btn-danger">
          Stop
        </button>
        <div className="controls-divider" />
        <button onClick={handleReset} className="btn btn-secondary">
          Reset
        </button>
        <button onClick={handleOpenLogs} className="btn btn-secondary">
          Open Logs
        </button>
        <button onClick={clearConsole} className="btn btn-secondary">
          Clear
        </button>
      </div>

      {showStartForm && (
        <div className="modal-overlay" onClick={() => setShowStartForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Start Pipeline</h2>
            <form onSubmit={handleStart}>
              <div className="form-group">
                <label htmlFor="projectDir">Project Directory</label>
                <input
                  id="projectDir"
                  type="text"
                  value={formData.projectDir}
                  onChange={(e) => setFormData({ ...formData, projectDir: e.target.value })}
                  placeholder="/path/to/your/project"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="task">Task Description</label>
                <textarea
                  id="task"
                  value={formData.task}
                  onChange={(e) => setFormData({ ...formData, task: e.target.value })}
                  placeholder="Describe what you want to build..."
                  rows={4}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="mode">Mode</label>
                <select
                  id="mode"
                  value={formData.mode}
                  onChange={(e) => setFormData({ ...formData, mode: e.target.value as 'autonomous' | 'interactive' })}
                >
                  <option value="autonomous">Autonomous</option>
                  <option value="interactive">Interactive</option>
                </select>
              </div>
              <div className="form-group checkbox">
                <input
                  id="stopAfterPrd"
                  type="checkbox"
                  checked={formData.stopAfterPrd}
                  onChange={(e) => setFormData({ ...formData, stopAfterPrd: e.target.checked })}
                />
                <label htmlFor="stopAfterPrd">Stop after PRD generation</label>
              </div>
              <div className="form-actions">
                <button type="button" onClick={() => setShowStartForm(false)} className="btn btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Start Pipeline
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="console" ref={consoleRef} onScroll={handleScroll}>
        {logs.length === 0 ? (
          <div className="console-empty">
            No logs yet. Start a pipeline to see output here.
          </div>
        ) : (
          logs.map((event, index) => (
            <div key={index} className={`log-line ${getLevelClass(event)}`}>
              {formatMessage(event)}
            </div>
          ))
        )}
      </div>

      {status?.state && (
        <footer className="footer">
          <span>Mode: {status.state.mode}</span>
          <span>Project: {status.state.projectDir}</span>
          {status.pauseRequested && <span className="pause-indicator">Pause Requested</span>}
          {status.hardStopRequested && <span className="stop-indicator">Stop Requested</span>}
        </footer>
      )}
    </div>
  );
}

export default App;
