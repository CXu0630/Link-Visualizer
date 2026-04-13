import React, { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react';
import { 
  FileText, 
  Link as LinkIcon, 
  RefreshCw, 
  AlertCircle, 
  ExternalLink, 
  LogIn, 
  LogOut, 
  Search,
  ZoomIn,
  ZoomOut,
  Maximize,
  Lock // Added Lock import to fix "Illegal constructor" error
} from 'lucide-react';

/**
 * CONFIGURATION
 * Replace CLIENT_ID with your Google Cloud Console Web Client ID
 */
const CLIENT_ID = "652620900258-2b641rfbhtnfqb3s99sbo2u2b6c5nafm.apps.googleusercontent.com"; // <--- INSERT YOUR CLIENT ID HERE
const SCOPES = "https://www.googleapis.com/auth/documents.readonly";
const DISCOVERY_DOCS = ["https://docs.googleapis.com/$discovery/rest?version=v1"];

export default function App() {
  // App State
  const [user, setUser] = useState(null);
  const [appState, setAppState] = useState('initializing'); // initializing, unauthorized, ready, loading, visualizing
  const [docIdsInput, setDocIdsInput] = useState('');
  const [error, setError] = useState(null);

  // Data State
  const [sourceDocs, setSourceDocs] = useState([]);
  const [targetDocs, setTargetDocs] = useState([]);
  const [edges, setEdges] = useState([]);

  // View State
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef(null);
  const tokenClient = useRef(null);

  // --- INITIALIZATION ---

  useEffect(() => {
    const initClient = () => {
      // Load GAPI
      const gapiScript = document.createElement('script');
      gapiScript.src = 'https://apis.google.com/js/api.js';
      gapiScript.onload = () => {
        window.gapi.load('client', async () => {
          await window.gapi.client.init({ discoveryDocs: DISCOVERY_DOCS });
          setAppState('unauthorized');
        });
      };
      document.body.appendChild(gapiScript);

      // Load GIS (Identity Services)
      const gisScript = document.createElement('script');
      gisScript.src = 'https://accounts.google.com/gsi/client';
      gisScript.onload = () => {
        tokenClient.current = window.google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SCOPES,
          callback: (resp) => {
            if (resp.error) {
              setError(`Auth Error: ${resp.error}`);
              return;
            }
            setUser(resp);
            setAppState('ready');
          },
        });
      };
      document.body.appendChild(gisScript);
    };

    initClient();
  }, []);

  // --- AUTH ACTIONS ---

  const handleAuth = () => {
    if (!tokenClient.current) return;
    tokenClient.current.requestAccessToken({ prompt: 'consent' });
  };

  const handleSignOut = () => {
    window.google.accounts.oauth2.revokeToken(user.access_token);
    setUser(null);
    setAppState('unauthorized');
    setSourceDocs([]);
    setTargetDocs([]);
  };

  // --- DATA FETCHING & PARSING ---

  const fetchAndProcessDocs = async () => {
    const ids = docIdsInput.split(/[\s,]+/).filter(id => id.trim().length > 5);
    if (ids.length === 0) {
      setError("Please enter valid Google Doc IDs.");
      return;
    }

    setAppState('loading');
    setError(null);

    try {
      const fetchedDocs = [];
      for (const id of ids) {
        try {
          const response = await window.gapi.client.docs.documents.get({ documentId: id });
          fetchedDocs.push(parseDocumentContent(response.result));
        } catch (e) {
          console.error(`Failed to fetch ${id}`, e);
        }
      }

      if (fetchedDocs.length === 0) throw new Error("Could not find any of the provided documents.");

      processLinksIntoGraph(fetchedDocs);
      setAppState('visualizing');
    } catch (err) {
      setError(err.message || "Failed to fetch documents.");
      setAppState('ready');
    }
  };

  const parseDocumentContent = (doc) => {
    const snippets = [];
    const fullContent = doc.body.content;
    
    // Flatten nested structure to find all text runs
    const processElement = (element) => {
      if (element.paragraph) {
        const p = element.paragraph;
        const pText = p.elements.map(e => e.textRun?.content || '').join('');
        
        let cursor = 0;
        p.elements.forEach(el => {
          const text = el.textRun?.content || '';
          const link = el.textRun?.textStyle?.link?.url;
          
          if (link) {
            snippets.push({
              id: `snip_${Math.random().toString(36).substr(2, 9)}`,
              linkText: text.trim(),
              textBefore: pText.substring(Math.max(0, cursor - 60), cursor).trim(),
              textAfter: pText.substring(cursor + text.length, Math.min(pText.length, cursor + text.length + 60)).trim(),
              target: {
                url: link,
                title: text.trim() || link
              }
            });
          }
          cursor += text.length;
        });
      } else if (element.table) {
        element.table.tableRows.forEach(row => {
          row.tableCells.forEach(cell => {
            cell.content.forEach(processElement);
          });
        });
      } else if (element.tableOfContents) {
        element.tableOfContents.content.forEach(processElement);
      }
    };

    fullContent.forEach(processElement);

    return {
      id: doc.documentId,
      title: doc.title,
      url: `https://docs.google.com/document/d/${doc.documentId}`,
      snippets
    };
  };

  const processLinksIntoGraph = (docs) => {
    const targetMap = new Map();
    const newEdges = [];

    docs.forEach(doc => {
      doc.snippets.forEach(snip => {
        // Collect Unique Targets
        if (!targetMap.has(snip.target.url)) {
          targetMap.set(snip.target.url, {
            ...snip.target,
            id: `target_${Math.random().toString(36).substr(2, 9)}`
          });
        }
        
        // Create Edge
        const targetNode = targetMap.get(snip.target.url);
        newEdges.push({
          id: `edge_${snip.id}`,
          from: snip.id,
          to: targetNode.id,
          type: 'direct'
        });
      });
    });

    setSourceDocs(docs);
    setTargetDocs(Array.from(targetMap.values()));
    setEdges(newEdges);
    setTransform({ x: 0, y: 0, scale: 0.8 }); // Start slightly zoomed out
  };

  // --- INTERACTION ---

  const handleMouseDown = (e) => {
    if (e.target.closest('.node-element')) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - transform.x, y: e.clientY - transform.y });
  };

  const handleMouseMove = (e) => {
    if (!isDragging) return;
    setTransform(prev => ({ ...prev, x: e.clientX - dragStart.x, y: e.clientY - dragStart.y }));
  };

  const handleWheel = (e) => {
    if (e.target.closest('.node-element')) return;
    const scaleFactor = e.deltaY > 0 ? 0.95 : 1.05;
    setTransform(prev => ({ ...prev, scale: Math.max(0.1, Math.min(prev.scale * scaleFactor, 3)) }));
  };

  const resetZoom = () => setTransform({ x: 0, y: 0, scale: 0.8 });

  // --- RENDERING ---

  if (appState === 'initializing') {
    return (
      <div className="min-h-screen bg-[#0f172a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
          <p className="text-slate-400 font-medium">Initializing Google Services...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-200 font-sans flex flex-col overflow-hidden">
      {/* Navbar */}
      <header className="h-16 flex items-center justify-between px-6 bg-[#1e293b] border-b border-slate-700/50 z-50 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-1.5 rounded-lg">
            <LinkIcon className="text-white w-5 h-5" />
          </div>
          <h1 className="text-lg font-bold tracking-tight text-white hidden sm:block">DocLink Explorer</h1>
        </div>

        <div className="flex items-center gap-4">
          {user && (
            <div className="flex items-center gap-3">
              <button 
                onClick={() => setAppState('ready')}
                className="p-2 text-slate-400 hover:text-white transition-colors"
                title="Search New Docs"
              >
                <Search className="w-5 h-5" />
              </button>
              <button 
                onClick={handleSignOut}
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-red-900/30 text-slate-300 hover:text-red-400 rounded-lg text-sm font-medium border border-slate-700 transition-all"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 relative flex items-center justify-center overflow-hidden">
        {/* State: Unauthorized */}
        {appState === 'unauthorized' && (
          <div className="max-w-md w-full p-8 bg-[#1e293b] rounded-2xl border border-slate-700 shadow-2xl text-center">
            <div className="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
              <Lock className="w-8 h-8 text-blue-500" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-3">Authentication Required</h2>
            <p className="text-slate-400 mb-8 text-sm leading-relaxed">
              To visualize links between your documents, we need read-only access to your Google Docs.
            </p>
            <button 
              onClick={handleAuth}
              className="w-full flex items-center justify-center gap-3 py-3 px-6 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold transition-all shadow-lg shadow-blue-900/20"
            >
              <LogIn className="w-5 h-5" />
              Sign in with Google
            </button>
          </div>
        )}

        {/* State: Ready (Input Form) */}
        {appState === 'ready' && (
          <div className="max-w-xl w-full p-10 bg-[#1e293b] rounded-2xl border border-slate-700 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 bg-blue-500 h-full" />
            <h2 className="text-2xl font-bold text-white mb-2">Build Your Link Map</h2>
            <p className="text-slate-400 mb-8 text-sm">Paste the Document IDs or full URLs from Google Docs below.</p>
            
            <div className="mb-6">
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Document IDs / URLs</label>
              <textarea 
                value={docIdsInput}
                onChange={(e) => setDocIdsInput(e.target.value)}
                className="w-full h-40 bg-[#0f172a] border border-slate-700 rounded-xl p-4 text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm resize-none"
                placeholder="1A2b3c4D5e, 9F8g7H6i5J..."
              />
            </div>

            {error && (
              <div className="mb-6 p-4 bg-red-900/20 border border-red-500/50 rounded-xl flex items-center gap-3 text-red-200 text-sm">
                <AlertCircle className="w-5 h-5 shrink-0" />
                {error}
              </div>
            )}

            <button 
              onClick={fetchAndProcessDocs}
              className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold transition-all shadow-lg shadow-blue-600/20 active:scale-[0.98]"
            >
              Visualize Connections
            </button>
          </div>
        )}

        {/* State: Loading */}
        {appState === 'loading' && (
          <div className="flex flex-col items-center gap-6">
            <div className="relative">
              <div className="w-16 h-16 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <FileText className="w-6 h-6 text-blue-500" />
              </div>
            </div>
            <p className="text-lg font-medium text-slate-300">Scanning Documents...</p>
          </div>
        )}

        {/* State: Visualizer */}
        {appState === 'visualizing' && (
          <>
            <div 
              ref={containerRef}
              className="absolute inset-0 cursor-grab active:cursor-grabbing select-none"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={() => setIsDragging(false)}
              onWheel={handleWheel}
            >
              {/* Background Grid */}
              <div 
                className="absolute inset-0 pointer-events-none opacity-20" 
                style={{ 
                  backgroundImage: `radial-gradient(#334155 1px, transparent 1px)`, 
                  backgroundSize: `${40 * transform.scale}px ${40 * transform.scale}px`,
                  backgroundPosition: `${transform.x}px ${transform.y}px`
                }} 
              />

              <div 
                className="absolute origin-top-left will-change-transform" 
                style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
              >
                <GraphLayer 
                  sourceDocs={sourceDocs} 
                  targetDocs={targetDocs} 
                  edges={edges} 
                />
              </div>
            </div>

            {/* Floating Controls */}
            <div className="absolute bottom-8 right-8 flex flex-col gap-2 z-50">
              <button onClick={() => setTransform(t => ({...t, scale: t.scale * 1.2}))} className="p-3 bg-[#1e293b] border border-slate-700 rounded-xl hover:bg-slate-700 text-white transition-colors"><ZoomIn className="w-5 h-5" /></button>
              <button onClick={() => setTransform(t => ({...t, scale: t.scale * 0.8}))} className="p-3 bg-[#1e293b] border border-slate-700 rounded-xl hover:bg-slate-700 text-white transition-colors"><ZoomOut className="w-5 h-5" /></button>
              <button onClick={resetZoom} className="p-3 bg-[#1e293b] border border-slate-700 rounded-xl hover:bg-slate-700 text-white transition-colors"><Maximize className="w-5 h-5" /></button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// --- SUB-COMPONENTS ---

const GraphLayer = ({ sourceDocs, targetDocs, edges }) => {
  const [nodePositions, setNodePositions] = useState({});
  const wrapperRef = useRef(null);

  const calculatePositions = useCallback(() => {
    if (!wrapperRef.current) return;
    const newPositions = {};
    const wrapperRect = wrapperRef.current.getBoundingClientRect();
    const trackers = wrapperRef.current.querySelectorAll('[data-track-id]');
    
    trackers.forEach(el => {
      const id = el.getAttribute('data-track-id');
      const rect = el.getBoundingClientRect();
      
      // Calculate center relative to wrapper
      newPositions[id] = {
        left: { 
          x: (rect.left - wrapperRect.left) / (wrapperRect.width / wrapperRef.current.offsetWidth), 
          y: (rect.top - wrapperRect.top + rect.height/2) / (wrapperRect.height / wrapperRef.current.offsetHeight) 
        },
        right: { 
          x: (rect.right - wrapperRect.left) / (wrapperRect.width / wrapperRef.current.offsetWidth), 
          y: (rect.top - wrapperRect.top + rect.height/2) / (wrapperRect.height / wrapperRef.current.offsetHeight) 
        }
      };
    });
    setNodePositions(newPositions);
  }, []);

  useLayoutEffect(() => {
    calculatePositions();
    const observer = new ResizeObserver(calculatePositions);
    if (wrapperRef.current) observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, [calculatePositions, sourceDocs, targetDocs]);

  const isExternal = (url) => url && !url.includes('docs.google.com') && !url.includes('google.com');

  return (
    <div ref={wrapperRef} className="relative p-40 min-w-max min-h-max flex items-start gap-64">
      {/* SVG Connection Layer */}
      <svg className="absolute inset-0 pointer-events-none z-20" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
        {edges.map(edge => {
          const from = nodePositions[edge.from];
          const to = nodePositions[edge.to];
          if (!from || !to) return null;

          const startX = from.right.x;
          const startY = from.right.y;
          const endX = to.left.x;
          const endY = to.left.y;
          
          const cp1x = startX + Math.max(100, (endX - startX) * 0.4);
          const cp2x = endX - Math.max(100, (endX - startX) * 0.4);

          return (
            <g key={edge.id}>
              <defs>
                <linearGradient id={`grad-${edge.id}`} x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#ec4899" stopOpacity="0.4" />
                </linearGradient>
              </defs>
              <path 
                d={`M ${startX} ${startY} C ${cp1x} ${startY}, ${cp2x} ${endY}, ${endX} ${endY}`} 
                fill="none" 
                stroke={`url(#grad-${edge.id})`}
                strokeWidth="3"
                className="drop-shadow-sm transition-all duration-300"
              />
              <circle cx={endX} cy={endY} r="4" fill="#ec4899" />
              <circle cx={startX} cy={startY} r="4" fill="#3b82f6" />
            </g>
          );
        })}
      </svg>

      {/* Source Nodes */}
      <div className="flex flex-col gap-20 node-element">
        {sourceDocs.map((doc, idx) => (
          <div key={doc.id} className="w-[500px] bg-[#1e293b] border border-blue-500/30 rounded-2xl shadow-2xl overflow-hidden group hover:border-blue-500/60 transition-all">
            <div className="px-6 py-5 border-b border-slate-700/50 flex items-center justify-between bg-blue-900/10">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-blue-500/20 rounded-xl flex items-center justify-center">
                  <FileText className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <p className="text-[10px] text-blue-400 font-black uppercase tracking-widest mb-0.5">Source Doc {idx + 1}</p>
                  <h3 className="text-lg font-bold text-white truncate max-w-[300px]">{doc.title}</h3>
                </div>
              </div>
              <button 
                onClick={() => window.open(doc.url, '_blank')}
                className="p-2 text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-all"
              >
                <ExternalLink className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 flex flex-col gap-5">
              {doc.snippets.map(snip => (
                <div 
                  key={snip.id} 
                  data-track-id={snip.id}
                  className="bg-[#0f172a] border border-slate-700/50 rounded-xl p-4 text-sm leading-relaxed text-slate-300 shadow-inner group-hover:border-blue-500/20 transition-all"
                >
                  <span className="opacity-50 italic">...{snip.textBefore}</span>
                  <span className="mx-1.5 px-2 py-0.5 bg-blue-500/20 text-blue-300 font-bold rounded-md border border-blue-500/30">
                    {snip.linkText}
                  </span>
                  <span className="opacity-50 italic">{snip.textAfter}...</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Target Nodes */}
      <div className="flex flex-col gap-20 node-element mt-32">
        {targetDocs.map((target, idx) => (
          <div 
            key={target.id} 
            data-track-id={target.id}
            className="w-[450px] bg-[#1e293b] border border-pink-500/30 rounded-2xl shadow-2xl overflow-hidden group hover:border-pink-500/60 transition-all"
          >
            <div className="px-6 py-5 border-b border-slate-700/50 flex items-center justify-between bg-pink-900/10">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-pink-500/20 rounded-xl flex items-center justify-center">
                  {isExternal(target.url) ? <LinkIcon className="w-5 h-5 text-pink-400" /> : <FileText className="w-5 h-5 text-pink-400" />}
                </div>
                <div>
                  <p className="text-[10px] text-pink-400 font-black uppercase tracking-widest mb-0.5">Link Box {idx + 1}</p>
                  <h3 className="text-lg font-bold text-white truncate max-w-[280px]">{target.title}</h3>
                </div>
              </div>
              <button 
                onClick={() => window.open(target.url, '_blank')}
                className="p-2 text-slate-500 hover:text-pink-400 hover:bg-pink-500/10 rounded-lg transition-all"
              >
                <ExternalLink className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6">
              <div className="bg-[#0f172a] p-4 rounded-xl border border-slate-700/50">
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider mb-2">Destination URL</p>
                <p className="text-xs font-mono text-pink-300 break-all leading-relaxed">{target.url}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};