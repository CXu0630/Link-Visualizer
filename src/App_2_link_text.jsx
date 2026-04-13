import React, {
  useState,
  useEffect,
  useRef,
  useLayoutEffect,
  useCallback,
  useMemo,
} from 'react';
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
  Lock,
  Hash,
} from 'lucide-react';

/**
 * CONFIGURATION
 * Replace CLIENT_ID with your Google Cloud Console Web Client ID
 */
const CLIENT_ID =
  '652620900258-2b641rfbhtnfqb3s99sbo2u2b6c5nafm.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/documents.readonly';
const DISCOVERY_DOCS = ['https://docs.googleapis.com/$discovery/rest?version=v1'];

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

const randomId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 11)}`;

const GOOGLE_DOC_REGEX = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;
const URL_REGEX = /^https?:\/\//i;

const extractDocId = (value) => {
  const trimmed = value.trim();
  const match = trimmed.match(GOOGLE_DOC_REGEX);
  if (match) return match[1];
  return trimmed;
};

const isGoogleDocUrl = (url) => /docs\.google\.com\/document\/d\//.test(url || '');

const isProbablyExternal = (url) => {
  if (!url) return false;
  return !/docs\.google\.com|google\.com/.test(url);
};

const extractGoogleDocIdFromUrl = (url) => {
  const match = (url || '').match(GOOGLE_DOC_REGEX);
  return match ? match[1] : null;
};

const extractHostname = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'inaccessible';
  }
};

const getInitialNodeOffsets = (sourceDocs, targetDocs) => {
  const next = {};
  sourceDocs.forEach((doc) => {
    next[doc.id] = { x: 0, y: 0 };
  });
  targetDocs.forEach((target) => {
    next[target.id] = { x: 0, y: 0 };
  });
  return next;
};

export default function App() {
  // App State
  const [user, setUser] = useState(null);
  const [appState, setAppState] = useState('initializing');
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

  useEffect(() => {
    const initClient = () => {
      const gapiScript = document.createElement('script');
      gapiScript.src = 'https://apis.google.com/js/api.js';
      gapiScript.onload = () => {
        window.gapi.load('client', async () => {
          await window.gapi.client.init({ discoveryDocs: DISCOVERY_DOCS });
          setAppState('unauthorized');
        });
      };
      document.body.appendChild(gapiScript);

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
    setEdges([]);
  };

  const resolveLinkTitle = async (url) => {
    if (!url) return { title: 'inaccessible', accessible: false };

    if (isGoogleDocUrl(url)) {
      const docId = extractGoogleDocIdFromUrl(url);
      if (!docId) return { title: 'inaccessible', accessible: false };

      try {
        const response = await window.gapi.client.docs.documents.get({ documentId: docId });
        return {
          title: response.result?.title || 'Untitled Google Doc',
          accessible: true,
        };
      } catch {
        return { title: 'inaccessible', accessible: false };
      }
    }

    try {
      const response = await fetch(url, { method: 'GET' });
      if (!response.ok) {
        return { title: 'inaccessible', accessible: false };
      }

      const html = await response.text();
      const parser = new DOMParser();
      const parsed = parser.parseFromString(html, 'text/html');
      const title = parsed.querySelector('title')?.textContent?.trim();

      return {
        title: title || extractHostname(url) || 'inaccessible',
        accessible: Boolean(title),
      };
    } catch {
      return { title: 'inaccessible', accessible: false };
    }
  };

  const fetchAndProcessDocs = async () => {
    const ids = docIdsInput
      .split(/[\s,]+/)
      .map(extractDocId)
      .filter((id) => id.trim().length > 5);

    if (ids.length === 0) {
      setError('Please enter valid Google Doc IDs.');
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

      if (fetchedDocs.length === 0) {
        throw new Error('Could not find any of the provided documents.');
      }

      await processLinksIntoGraph(fetchedDocs);
      setAppState('visualizing');
    } catch (err) {
      setError(err.message || 'Failed to fetch documents.');
      setAppState('ready');
    }
  };

  const parseDocumentContent = (doc) => {
    const snippets = [];
    const fullContent = doc.body.content;

    const processElement = (element) => {
      if (element.paragraph) {
        const p = element.paragraph;
        const pText = p.elements.map((e) => e.textRun?.content || '').join('');

        let cursor = 0;
        p.elements.forEach((el) => {
          const text = el.textRun?.content || '';
          const link = el.textRun?.textStyle?.link?.url;

          if (link) {
            snippets.push({
              id: randomId('snip'),
              linkText: text.trim(),
              textBefore: pText.substring(Math.max(0, cursor - 60), cursor).trim(),
              textAfter: pText
                .substring(cursor + text.length, Math.min(pText.length, cursor + text.length + 60))
                .trim(),
              target: {
                url: link,
                title: text.trim() || link,
              },
            });
          }
          cursor += text.length;
        });
      } else if (element.table) {
        element.table.tableRows.forEach((row) => {
          row.tableCells.forEach((cell) => {
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
      snippets,
    };
  };

  const processLinksIntoGraph = async (docs) => {
    const targetMap = new Map();
    const directEdges = [];
    const snippetsByTarget = new Map();

    docs.forEach((doc) => {
      doc.snippets.forEach((snip) => {
        if (!targetMap.has(snip.target.url)) {
          targetMap.set(snip.target.url, {
            id: randomId('target'),
            url: snip.target.url,
            title: snip.target.title,
            resolvedTitle: null,
            refCount: 0,
            accessible: null,
          });
        }

        const targetNode = targetMap.get(snip.target.url);
        targetNode.refCount += 1;

        if (!snippetsByTarget.has(snip.target.url)) {
          snippetsByTarget.set(snip.target.url, []);
        }
        snippetsByTarget.get(snip.target.url).push(snip);

        directEdges.push({
          id: randomId('edge'),
          from: snip.id,
          to: targetNode.id,
          edgeType: 'direct',
          sharedUrl: snip.target.url,
        });
      });
    });

    const resolvedTargets = await Promise.all(
      Array.from(targetMap.values()).map(async (target) => {
        const resolved = await resolveLinkTitle(target.url);
        return {
          ...target,
          title:
            resolved.title === 'inaccessible'
              ? isGoogleDocUrl(target.url)
                ? 'inaccessible'
                : target.title || 'inaccessible'
              : resolved.title,
          resolvedTitle: resolved.title,
          accessible: resolved.accessible,
        };
      })
    );

    const sourceLinkEdges = [];
    snippetsByTarget.forEach((snippets, sharedUrl) => {
      if (snippets.length < 2) return;

      for (let i = 0; i < snippets.length; i += 1) {
        for (let j = i + 1; j < snippets.length; j += 1) {
          sourceLinkEdges.push({
            id: randomId('shared'),
            from: snippets[i].id,
            to: snippets[j].id,
            edgeType: 'shared',
            sharedUrl,
          });
        }
      }
    });

    setSourceDocs(docs);
    setTargetDocs(resolvedTargets);
    setEdges([...sourceLinkEdges, ...directEdges]);
    setTransform({ x: 0, y: 0, scale: 0.8 });
  };

  const handleMouseDown = (e) => {
    if (e.target.closest('.node-element') || e.target.closest('.edge-hitbox')) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - transform.x, y: e.clientY - transform.y });
  };

  const handleMouseMove = (e) => {
    if (!isDragging) return;
    setTransform((prev) => ({ ...prev, x: e.clientX - dragStart.x, y: e.clientY - dragStart.y }));
  };

  const stopPanning = () => setIsDragging(false);

  const handleWheel = (e) => {
    if (e.target.closest('.node-element')) return;
    const scaleFactor = e.deltaY > 0 ? 0.95 : 1.05;
    setTransform((prev) => ({ ...prev, scale: clamp(prev.scale * scaleFactor, 0.1, 3) }));
  };

  const resetZoom = () => setTransform({ x: 0, y: 0, scale: 0.8 });

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

        {appState === 'ready' && (
          <div className="max-w-xl w-full p-10 bg-[#1e293b] rounded-2xl border border-slate-700 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 bg-blue-500 h-full" />
            <h2 className="text-2xl font-bold text-white mb-2">Build Your Link Map</h2>
            <p className="text-slate-400 mb-8 text-sm">Paste the Document IDs or full URLs from Google Docs below.</p>

            <div className="mb-6">
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                Document IDs / URLs
              </label>
              <textarea
                value={docIdsInput}
                onChange={(e) => setDocIdsInput(e.target.value)}
                className="w-full h-40 bg-[#0f172a] border border-slate-700 rounded-xl p-4 text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm resize-none"
                placeholder="1A2b3c4D5e, https://docs.google.com/document/d/..."
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

        {appState === 'visualizing' && (
          <>
            <div
              ref={containerRef}
              className="absolute inset-0 cursor-grab active:cursor-grabbing select-none"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={stopPanning}
              onMouseLeave={stopPanning}
              onWheel={handleWheel}
            >
              <div
                className="absolute inset-0 pointer-events-none opacity-20"
                style={{
                  backgroundImage: `radial-gradient(#334155 1px, transparent 1px)`,
                  backgroundSize: `${40 * transform.scale}px ${40 * transform.scale}px`,
                  backgroundPosition: `${transform.x}px ${transform.y}px`,
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
                  currentScale={transform.scale}
                />
              </div>
            </div>

            <div className="absolute bottom-8 right-8 flex flex-col gap-2 z-50">
              <button
                onClick={() => setTransform((t) => ({ ...t, scale: clamp(t.scale * 1.2, 0.1, 3) }))}
                className="p-3 bg-[#1e293b] border border-slate-700 rounded-xl hover:bg-slate-700 text-white transition-colors"
              >
                <ZoomIn className="w-5 h-5" />
              </button>
              <button
                onClick={() => setTransform((t) => ({ ...t, scale: clamp(t.scale * 0.8, 0.1, 3) }))}
                className="p-3 bg-[#1e293b] border border-slate-700 rounded-xl hover:bg-slate-700 text-white transition-colors"
              >
                <ZoomOut className="w-5 h-5" />
              </button>
              <button
                onClick={resetZoom}
                className="p-3 bg-[#1e293b] border border-slate-700 rounded-xl hover:bg-slate-700 text-white transition-colors"
              >
                <Maximize className="w-5 h-5" />
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

const GraphLayer = ({ sourceDocs, targetDocs, edges, currentScale }) => {
  const [nodePositions, setNodePositions] = useState({});
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [nodeOffsets, setNodeOffsets] = useState(() => getInitialNodeOffsets(sourceDocs, targetDocs));
  const [draggingNode, setDraggingNode] = useState(null);
  const wrapperRef = useRef(null);
  const dragMetaRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    setNodeOffsets((prev) => {
      const initial = getInitialNodeOffsets(sourceDocs, targetDocs);
      Object.keys(initial).forEach((id) => {
        if (prev[id]) initial[id] = prev[id];
      });
      return initial;
    });
  }, [sourceDocs, targetDocs]);

  const calculatePositions = useCallback(() => {
    if (!wrapperRef.current) return;

    const newPositions = {};
    const wrapperRect = wrapperRef.current.getBoundingClientRect();
    const trackers = wrapperRef.current.querySelectorAll('[data-track-id]');
    const xRatio = wrapperRect.width / wrapperRef.current.offsetWidth || 1;
    const yRatio = wrapperRect.height / wrapperRef.current.offsetHeight || 1;

    trackers.forEach((el) => {
      const id = el.getAttribute('data-track-id');
      const rect = el.getBoundingClientRect();

      newPositions[id] = {
        left: {
          x: (rect.left - wrapperRect.left) / xRatio,
          y: (rect.top - wrapperRect.top + rect.height / 2) / yRatio,
        },
        right: {
          x: (rect.right - wrapperRect.left) / xRatio,
          y: (rect.top - wrapperRect.top + rect.height / 2) / yRatio,
        },
        top: {
          x: (rect.left - wrapperRect.left + rect.width / 2) / xRatio,
          y: (rect.top - wrapperRect.top) / yRatio,
        },
        bottom: {
          x: (rect.left - wrapperRect.left + rect.width / 2) / xRatio,
          y: (rect.bottom - wrapperRect.top) / yRatio,
        },
      };
    });

    setNodePositions(newPositions);
  }, []);

  useLayoutEffect(() => {
    calculatePositions();
  }, [calculatePositions, nodeOffsets, sourceDocs, targetDocs]);

  useLayoutEffect(() => {
    const observer = new ResizeObserver(calculatePositions);
    if (wrapperRef.current) observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, [calculatePositions]);

  useEffect(() => {
    if (!draggingNode) return undefined;

    const tick = () => {
      calculatePositions();
      rafRef.current = window.requestAnimationFrame(tick);
    };

    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [draggingNode, calculatePositions]);

  useEffect(() => {
    if (!draggingNode) return undefined;

    const handleMouseMove = (e) => {
      if (!dragMetaRef.current) return;
      const { id, startClientX, startClientY, startOffset } = dragMetaRef.current;
      const dx = (e.clientX - startClientX) / currentScale;
      const dy = (e.clientY - startClientY) / currentScale;

      setNodeOffsets((prev) => ({
        ...prev,
        [id]: {
          x: startOffset.x + dx,
          y: startOffset.y + dy,
        },
      }));
    };

    const handleMouseUp = () => {
      setDraggingNode(null);
      dragMetaRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingNode, currentScale]);

  const edgeMeta = useMemo(() => {
    const targetTitleMap = new Map(targetDocs.map((t) => [t.url, t.title]));
    return new Map(
      edges.map((edge) => [
        edge.id,
        {
          label:
            edge.edgeType === 'shared'
              ? `Shared reference: ${targetTitleMap.get(edge.sharedUrl) || edge.sharedUrl}`
              : targetTitleMap.get(edge.sharedUrl) || edge.sharedUrl,
        },
      ])
    );
  }, [edges, targetDocs]);

  const startNodeDrag = (e, id) => {
    e.stopPropagation();
    dragMetaRef.current = {
      id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startOffset: nodeOffsets[id] || { x: 0, y: 0 },
    };
    setDraggingNode(id);
  };

  const getEdgePath = (edge) => {
    const from = nodePositions[edge.from];
    const to = nodePositions[edge.to];
    if (!from || !to) return null;

    if (edge.edgeType === 'shared') {
      const startX = from.left.x;
      const startY = from.left.y;
      const endX = to.left.x;
      const endY = to.left.y;
      const bow = Math.max(140, Math.abs(endY - startY) * 0.35 + 100);
      const controlX = Math.min(startX, endX) - bow;
      return {
        path: `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`,
        startX,
        startY,
        endX,
        endY,
      };
    }

    const startX = from.right.x;
    const startY = from.right.y;
    const endX = to.left.x;
    const endY = to.left.y;
    const cp1x = startX + Math.max(100, (endX - startX) * 0.4);
    const cp2x = endX - Math.max(100, (endX - startX) * 0.4);

    return {
      path: `M ${startX} ${startY} C ${cp1x} ${startY}, ${cp2x} ${endY}, ${endX} ${endY}`,
      startX,
      startY,
      endX,
      endY,
    };
  };

  const renderVisualEdge = (edge) => {
    const geometry = getEdgePath(edge);
    if (!geometry) return null;

    const { path, startX, startY, endX, endY } = geometry;
    const isSelected = selectedEdgeId === edge.id;

    if (edge.edgeType === 'shared') {
      return (
        <g key={`visual-${edge.id}`}>
          <path
            d={path}
            fill="none"
            stroke={isSelected ? '#facc15' : '#94a3b8'}
            strokeWidth={isSelected ? '4' : '2.5'}
            strokeDasharray="7 6"
            opacity={isSelected ? 1 : 0.7}
            className="transition-all duration-200"
          />
        </g>
      );
    }

    return (
      <g key={`visual-${edge.id}`}>
        <defs>
          <linearGradient id={`grad-${edge.id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop
              offset="0%"
              stopColor={isSelected ? '#facc15' : '#3b82f6'}
              stopOpacity={isSelected ? '0.95' : '0.45'}
            />
            <stop
              offset="100%"
              stopColor={isSelected ? '#f59e0b' : '#ec4899'}
              stopOpacity={isSelected ? '0.95' : '0.45'}
            />
          </linearGradient>
        </defs>
        <path
          d={path}
          fill="none"
          stroke={`url(#grad-${edge.id})`}
          strokeWidth={isSelected ? '5' : '3'}
          className="transition-all duration-200"
          filter={isSelected ? 'drop-shadow(0 0 8px rgba(250, 204, 21, 0.65))' : undefined}
        />
        <circle
          cx={endX}
          cy={endY}
          r={isSelected ? '5' : '4'}
          fill={isSelected ? '#f59e0b' : '#ec4899'}
        />
        <circle
          cx={startX}
          cy={startY}
          r={isSelected ? '5' : '4'}
          fill={isSelected ? '#facc15' : '#3b82f6'}
        />
      </g>
    );
  };

  const renderHitboxEdge = (edge) => {
    const geometry = getEdgePath(edge);
    if (!geometry) return null;

    return (
      <path
        key={`hitbox-${edge.id}`}
        d={geometry.path}
        fill="none"
        stroke="transparent"
        strokeWidth="18"
        className="edge-hitbox"
        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
        onClick={(e) => {
          e.stopPropagation();
          setSelectedEdgeId((prev) => (prev === edge.id ? null : edge.id));
        }}
      />
    );
  };

  return (
    <div ref={wrapperRef} className="relative p-40 min-w-max min-h-max flex items-start gap-64">
      <div className="flex flex-col gap-20 node-element relative z-20">
        {sourceDocs.map((doc, idx) => (
          <div
            key={doc.id}
            data-track-id={doc.id}
            onMouseDown={(e) => startNodeDrag(e, doc.id)}
            className="w-[500px] bg-[#1e293b] border border-blue-500/30 rounded-2xl shadow-2xl overflow-hidden group hover:border-blue-500/60 transition-all cursor-move"
            style={{ transform: `translate(${nodeOffsets[doc.id]?.x || 0}px, ${nodeOffsets[doc.id]?.y || 0}px)` }}
          >
            <div className="px-6 py-5 border-b border-slate-700/50 flex items-center justify-between bg-blue-900/10">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-10 h-10 bg-blue-500/20 rounded-xl flex items-center justify-center shrink-0">
                  <FileText className="w-5 h-5 text-blue-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-blue-400 font-black uppercase tracking-widest mb-0.5">
                    Source Doc {idx + 1}
                  </p>
                  <h3 className="text-lg font-bold text-white truncate max-w-[300px]">{doc.title}</h3>
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(doc.url, '_blank', 'noopener,noreferrer');
                }}
                className="p-2 text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-all shrink-0"
              >
                <ExternalLink className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 flex flex-col gap-5">
              {doc.snippets.map((snip) => (
                <div
                  key={snip.id}
                  data-track-id={snip.id}
                  className="bg-[#0f172a] border border-slate-700/50 rounded-xl p-4 text-sm leading-relaxed text-slate-300 shadow-inner group-hover:border-blue-500/20 transition-all"
                >
                  <span className="opacity-50 italic">...{snip.textBefore}</span>
                  <span className="mx-1.5 px-2 py-0.5 bg-blue-500/20 text-blue-300 font-bold rounded-md border border-blue-500/30">
                    {snip.linkText || 'linked text'}
                  </span>
                  <span className="opacity-50 italic">{snip.textAfter}...</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-20 node-element mt-32 relative z-20">
        {targetDocs.map((target, idx) => (
          <div
            key={target.id}
            data-track-id={target.id}
            onMouseDown={(e) => startNodeDrag(e, target.id)}
            className="w-[450px] bg-[#1e293b] border border-pink-500/30 rounded-2xl shadow-2xl overflow-hidden group hover:border-pink-500/60 transition-all cursor-move"
            style={{ transform: `translate(${nodeOffsets[target.id]?.x || 0}px, ${nodeOffsets[target.id]?.y || 0}px)` }}
          >
            <div className="px-6 py-5 border-b border-slate-700/50 flex items-center justify-between bg-pink-900/10">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-10 h-10 bg-pink-500/20 rounded-xl flex items-center justify-center shrink-0">
                  {isProbablyExternal(target.url) ? (
                    <LinkIcon className="w-5 h-5 text-pink-400" />
                  ) : (
                    <FileText className="w-5 h-5 text-pink-400" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-pink-400 font-black uppercase tracking-widest mb-0.5">
                    Link Box {idx + 1}
                  </p>
                  <h3 className="text-lg font-bold text-white truncate max-w-[280px]">{target.title}</h3>
                  <p className="text-xs text-slate-400 truncate max-w-[280px]">{extractHostname(target.url)}</p>
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(target.url, '_blank', 'noopener,noreferrer');
                }}
                className="p-2 text-slate-500 hover:text-pink-400 hover:bg-pink-500/10 rounded-lg transition-all shrink-0"
              >
                <ExternalLink className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-[#0f172a] p-4 rounded-xl border border-slate-700/50">
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider mb-2">Ref Count</p>
                <div className="flex items-center gap-2 text-pink-300 font-semibold">
                  <span>{target.refCount}</span>
                </div>
              </div>
              <div className="bg-[#0f172a] p-4 rounded-xl border border-slate-700/50">
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider mb-2">
                  Resolved Title Status
                </p>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {target.resolvedTitle === 'inaccessible'
                    ? 'Could not read the title directly. Usually this means auth, CORS, or permissions blocked it.'
                    : 'Title pulled from the destination successfully.'}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <svg
        className="absolute inset-0 z-30 pointer-events-none"
        style={{ width: '100%', height: '100%', overflow: 'visible' }}
      >
        {edges.filter((e) => e.edgeType === 'shared').map(renderVisualEdge)}
        {edges.filter((e) => e.edgeType === 'direct').map(renderVisualEdge)}
      </svg>

      <svg
        className="absolute inset-0 z-40 pointer-events-none"
        style={{ width: '100%', height: '100%', overflow: 'visible' }}
      >
        {edges.filter((e) => e.edgeType === 'shared').map(renderHitboxEdge)}
        {edges.filter((e) => e.edgeType === 'direct').map(renderHitboxEdge)}
      </svg>

      {selectedEdgeId && edgeMeta.get(selectedEdgeId) && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-slate-900/95 border border-yellow-400/40 shadow-2xl text-sm text-slate-100">
          {edgeMeta.get(selectedEdgeId).label}
        </div>
      )}
    </div>
  );
};