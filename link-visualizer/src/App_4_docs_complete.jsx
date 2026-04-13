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
  Eye,
  EyeOff,
  ChevronRight,
  Layers,
  Plus,
  X
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

const extractDocId = (value) => {
  const trimmed = value.trim();
  const match = trimmed.match(GOOGLE_DOC_REGEX);
  if (match) return match[1];
  return trimmed;
};

const isGoogleDocUrl = (url) => /docs\.google\.com\/document\/d\//.test(url || '');

const extractHostname = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'inaccessible';
  }
};

const getInitialNodeOffsets = (sourceDocs, targetDocs) => {
  const next = {};
  let currentX = 50;

  sourceDocs.forEach((doc) => {
    next[doc.id] = { x: currentX, y: 50 };
    currentX += 950; // 850 (doc width) + 100 (gap)

    let currentTargetY = 50;
    let addedTargets = false;

    targetDocs.forEach((target) => {
      // Place target directly next to the *first* doc that references it
      if (!next[target.id] && target.referencedByDocs?.has(doc.id)) {
        next[target.id] = { x: currentX, y: currentTargetY };
        currentTargetY += 200;
        addedTargets = true;
      }
    });

    if (addedTargets) {
      currentX += 450; // 350 (target width) + 100 (gap)
    }
  });

  // Handle any remaining unplaced targets
  let currentTargetY = 50;
  targetDocs.forEach((target) => {
    if (!next[target.id]) {
      next[target.id] = { x: currentX, y: currentTargetY };
      currentTargetY += 200;
    }
  });

  return next;
};

export default function App() {
  const [user, setUser] = useState(null);
  const [appState, setAppState] = useState('initializing');
  const [docIdsInput, setDocIdsInput] = useState('');
  const [error, setError] = useState(null);

  const [sourceDocs, setSourceDocs] = useState([]);
  const [targetDocs, setTargetDocs] = useState([]);
  const [edges, setEdges] = useState([]);

  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 0.9 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [selectedNodes, setSelectedNodes] = useState(new Set());
  
  // Visibility & Sidebar State
  const [showLinkBoxes, setShowLinkBoxes] = useState(true);
  const [hiddenDocs, setHiddenDocs] = useState(new Set());
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  
  // Add Document State
  const [isAddingDoc, setIsAddingDoc] = useState(false);
  const [newDocInput, setNewDocInput] = useState('');
  const [isAddingLoading, setIsAddingLoading] = useState(false);
  
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
    setSelectedNodes(new Set());
    setHiddenDocs(new Set());
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
    setSelectedNodes(new Set());
    setHiddenDocs(new Set());

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

  const handleAddSingleDoc = async () => {
    const id = extractDocId(newDocInput);
    if (!id || id.length < 5) return;

    if (sourceDocs.some(d => d.id === id)) {
      alert("This document is already in the canvas.");
      return;
    }

    setIsAddingLoading(true);
    try {
      const response = await window.gapi.client.docs.documents.get({ documentId: id });
      const fetchedDoc = parseDocumentContent(response.result);

      // Pass existing items + new item to graph merger
      const newDocs = [...sourceDocs, fetchedDoc];
      await processLinksIntoGraph(newDocs, true);

      setNewDocInput('');
      setIsAddingDoc(false);
    } catch (err) {
      console.error(err);
      alert(`Failed to add document: ${err.message || 'Check permissions or ID'}`);
    } finally {
      setIsAddingLoading(false);
    }
  };

  // Reconstruct the text blocks from Google Docs format
  const parseDocumentContent = (doc) => {
    const blocks = [];
    const links = [];
    const fullContent = doc.body.content;

    const processParagraph = (paragraph, blockId) => {
      const runs = [];
      paragraph.elements.forEach((el, elIdx) => {
        if (el.textRun) {
          const text = el.textRun.content;
          const url = el.textRun.textStyle?.link?.url;
          let linkId = null;

          if (url) {
            linkId = randomId('link');
            links.push({
              id: linkId,
              url: url,
              title: text.trim() || url,
              docId: doc.documentId,
            });
          }

          runs.push({
            id: linkId || randomId('text'),
            text: text,
            url: url,
            bold: el.textRun.textStyle?.bold,
            italic: el.textRun.textStyle?.italic,
            underline: el.textRun.textStyle?.underline,
          });
        }
      });
      return { id: blockId, type: 'paragraph', runs };
    };

    const processElement = (element, blockId) => {
      if (element.paragraph) {
        return processParagraph(element.paragraph, blockId);
      } else if (element.table) {
        const rows = element.table.tableRows.map((row, rIdx) => {
          const cells = row.tableCells.map((cell, cIdx) => {
            const cellBlocks = [];
            if (cell.content) {
              cell.content.forEach((cellEl, ceIdx) => {
                const b = processElement(cellEl, `${blockId}_r${rIdx}_c${cIdx}_b${ceIdx}`);
                if (b) cellBlocks.push(b);
              });
            }
            return { id: `${blockId}_r${rIdx}_c${cIdx}`, blocks: cellBlocks };
          });
          return { id: `${blockId}_r${rIdx}`, cells };
        });
        return { id: blockId, type: 'table', rows };
      }
      return null;
    };

    fullContent.forEach((el, idx) => {
      const block = processElement(el, `block_${idx}`);
      if (block) blocks.push(block);
    });

    return {
      id: doc.documentId,
      title: doc.title,
      url: `https://docs.google.com/document/d/${doc.documentId}`,
      blocks,
      links,
    };
  };

  const processLinksIntoGraph = async (docs, isAppending = false) => {
    const targetMap = new Map();
    const directEdges = [];
    const linksByUrl = new Map();

    // If appending, preserve IDs of target link boxes that already exist on canvas
    if (isAppending) {
      targetDocs.forEach(t => {
        targetMap.set(t.url, { ...t, refCount: 0, referencedByDocs: new Set() });
      });
    }

    // Collect all links and their destinations
    docs.forEach((doc) => {
      doc.links.forEach((link) => {
        if (!linksByUrl.has(link.url)) linksByUrl.set(link.url, []);
        linksByUrl.get(link.url).push(link);

        if (!targetMap.has(link.url)) {
          targetMap.set(link.url, {
            id: randomId('target'),
            url: link.url,
            title: link.title,
            refCount: 0,
            referencedByDocs: new Set(),
          });
        }
        
        const targetNode = targetMap.get(link.url);
        targetNode.refCount += 1;
        targetNode.referencedByDocs.add(doc.id); // Track which docs point here

        // Direct edge from the link in the doc to the target URL node
        directEdges.push({
          id: randomId('edge'),
          from: link.id,
          to: targetNode.id,
          edgeType: 'direct',
          sharedUrl: link.url,
          sourceDocId: doc.id,
        });
      });
    });

    // Create cross-document shared edges (connecting two docs that have the same link)
    const sharedEdges = [];
    linksByUrl.forEach((links, url) => {
      if (links.length < 2) return;

      for (let i = 0; i < links.length; i += 1) {
        for (let j = i + 1; j < links.length; j += 1) {
          if (links[i].docId !== links[j].docId) { // Only draw lines between different docs
            sharedEdges.push({
              id: randomId('shared'),
              from: links[i].id,
              to: links[j].id,
              edgeType: 'shared',
              sharedUrl: url,
              sourceDocId: links[i].docId,
              targetDocId: links[j].docId,
            });
          }
        }
      }
    });

    setSourceDocs(docs);
    setTargetDocs(Array.from(targetMap.values()));
    setEdges([...sharedEdges, ...directEdges]);
    
    // Only reset camera position if this is a fresh setup
    if (!isAppending) {
      setTransform({ x: 0, y: 0, scale: 0.9 });
    }
  };

  const handleMouseDown = (e) => {
    if (e.target.closest('.node-element') || e.target.closest('.edge-hitbox')) return;
    
    // Globally handle Marquee Drag on background click
    if (e.shiftKey) {
      window.dispatchEvent(new CustomEvent('start-marquee', { detail: { clientX: e.clientX, clientY: e.clientY } }));
      return;
    }
    
    setSelectedNodes(new Set()); // Deselect all when clicking canvas
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

  const resetZoom = () => setTransform({ x: 0, y: 0, scale: 0.9 });

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
          <h1 className="text-lg font-bold tracking-tight text-white hidden sm:block">DocLink Text Renderer</h1>
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
            <h2 className="text-2xl font-bold text-white mb-2">Render Document Graph</h2>
            <p className="text-slate-400 mb-8 text-sm">Paste Document IDs or URLs to parse their textual content and connect them.</p>

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
              Parse and Visualize
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
            <p className="text-lg font-medium text-slate-300">Reconstructing text & connections...</p>
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
                  selectedNodes={selectedNodes}
                  setSelectedNodes={setSelectedNodes}
                  showLinkBoxes={showLinkBoxes}
                  hiddenDocs={hiddenDocs}
                />
              </div>
            </div>
            
            {/* Sidebar Visibility Panel */}
            <div className={`absolute top-0 right-0 h-full bg-[#1e293b] border-l border-slate-700 shadow-2xl transition-transform duration-300 z-50 flex flex-col w-72 ${isSidebarOpen ? 'translate-x-0' : 'translate-x-full'}`}>
              <button
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                className="absolute -left-12 top-6 p-2.5 bg-[#1e293b] border border-r-0 border-slate-700 rounded-l-xl text-slate-300 hover:text-white shadow-[-4px_4px_10px_rgba(0,0,0,0.2)] transition-colors"
                title="Toggle Layers Panel"
              >
                {isSidebarOpen ? <ChevronRight className="w-5 h-5" /> : <Layers className="w-5 h-5" />}
              </button>

              <div className="p-5 border-b border-slate-700 flex items-center gap-3 shrink-0">
                <Layers className="w-5 h-5 text-blue-400" />
                <h2 className="font-bold text-white tracking-wide">Layers</h2>
              </div>

              <div className="p-5 flex-1 overflow-y-auto flex flex-col gap-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-pink-500" />
                    <span className="text-sm font-bold text-slate-200">Link Boxes</span>
                  </div>
                  <button onClick={() => setShowLinkBoxes(!showLinkBoxes)} className="text-slate-400 hover:text-white transition-colors">
                    {showLinkBoxes ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
                  </button>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Documents</span>
                    <button 
                      onClick={() => setIsAddingDoc(!isAddingDoc)} 
                      className="p-1 text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-600 transition-colors rounded"
                      title="Add a Document"
                    >
                      {isAddingDoc ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {isAddingDoc && (
                    <div className="mb-4 flex flex-col gap-2 p-3 bg-slate-800/80 rounded-lg border border-slate-600 shadow-inner">
                      <input
                        type="text"
                        value={newDocInput}
                        onChange={(e) => setNewDocInput(e.target.value)}
                        placeholder="Paste Doc URL or ID..."
                        className="w-full bg-[#0f172a] border border-slate-600 rounded px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleAddSingleDoc();
                        }}
                      />
                      <button
                        onClick={handleAddSingleDoc}
                        disabled={isAddingLoading || newDocInput.trim().length < 5}
                        className="w-full py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white text-xs font-bold rounded transition-colors flex justify-center items-center gap-2"
                      >
                        {isAddingLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : 'Append to Canvas'}
                      </button>
                    </div>
                  )}

                  <div className="flex flex-col gap-3">
                    {sourceDocs.map(doc => {
                      const isHidden = hiddenDocs.has(doc.id);
                      return (
                        <div key={doc.id} className="flex items-center justify-between pl-3 border-l-2 border-blue-500/50">
                          <span className="text-sm text-slate-300 truncate pr-3" title={doc.title}>{doc.title}</span>
                          <button onClick={() => {
                            const next = new Set(hiddenDocs);
                            if (isHidden) next.delete(doc.id); else next.add(doc.id);
                            setHiddenDocs(next);
                          }} className="text-slate-400 hover:text-white shrink-0 transition-colors">
                            {!isHidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Multi-select help tooltip */}
            <div className="absolute bottom-8 left-8 z-50 px-4 py-3 flex flex-col gap-1.5 bg-slate-900/80 backdrop-blur border border-slate-700 rounded-xl text-slate-300 text-sm shadow-xl pointer-events-none">
              <div><span className="font-bold text-white">Select:</span> Shift-click or Shift-drag to select multiple nodes.</div>
              <div><span className="font-bold text-white">Undo:</span> Cmd/Ctrl + Z to undo component movements.</div>
            </div>

            {/* Zoom Controls shift when sidebar opens */}
            <div className={`absolute bottom-8 transition-all duration-300 z-40 flex flex-col gap-2 ${isSidebarOpen ? 'right-[20rem]' : 'right-8'}`}>
              <button
                onClick={() => setTransform((t) => ({ ...t, scale: clamp(t.scale * 1.2, 0.1, 3) }))}
                className="p-3 bg-[#1e293b] border border-slate-700 rounded-xl hover:bg-slate-700 text-white transition-colors shadow-lg"
              >
                <ZoomIn className="w-5 h-5" />
              </button>
              <button
                onClick={() => setTransform((t) => ({ ...t, scale: clamp(t.scale * 0.8, 0.1, 3) }))}
                className="p-3 bg-[#1e293b] border border-slate-700 rounded-xl hover:bg-slate-700 text-white transition-colors shadow-lg"
              >
                <ZoomOut className="w-5 h-5" />
              </button>
              <button
                onClick={resetZoom}
                className="p-3 bg-[#1e293b] border border-slate-700 rounded-xl hover:bg-slate-700 text-white transition-colors shadow-lg"
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

const DocumentBlock = ({ block, calculatePositions }) => {
  if (block.type === 'paragraph') {
    return (
      <p className="mb-4 break-words">
        {block.runs.map((run) => {
          const style = {
            fontWeight: run.bold ? 'bold' : 'normal',
            fontStyle: run.italic ? 'italic' : 'normal',
            textDecoration: run.underline ? 'underline' : 'none',
          };

          if (run.url) {
            return (
              <a
                key={run.id}
                data-track-id={run.id}
                href={run.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 bg-blue-50/60 px-1 rounded hover:bg-blue-100 relative group transition-colors"
                style={style}
                onMouseEnter={() => calculatePositions()} // Ensure accurate position on hover
              >
                {run.text}
                {/* Invisible anchor dot for aesthetics */}
                <span className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-blue-500 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              </a>
            );
          }
          return (
            <span key={run.id} style={style}>
              {run.text}
            </span>
          );
        })}
      </p>
    );
  }

  if (block.type === 'table') {
    return (
      <div className="overflow-x-auto mb-4 w-full rounded-lg shadow-sm border border-slate-200" onScroll={calculatePositions}>
        <table className="w-full border-collapse bg-slate-50/50 text-sm">
          <tbody>
            {block.rows.map((row) => (
              <tr key={row.id}>
                {row.cells.map((cell) => (
                  <td key={cell.id} className="border border-slate-200 p-3 align-top min-w-[120px]">
                    {cell.blocks.map((b) => (
                      <DocumentBlock key={b.id} block={b} calculatePositions={calculatePositions} />
                    ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return null;
};

const GraphLayer = ({ sourceDocs, targetDocs, edges, currentScale, selectedNodes, setSelectedNodes, showLinkBoxes, hiddenDocs }) => {
  const [nodePositions, setNodePositions] = useState({});
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [nodeOffsets, setNodeOffsets] = useState(() => getInitialNodeOffsets(sourceDocs, targetDocs));
  const [draggingNode, setDraggingNode] = useState(null);
  
  const [isSelectingMarquee, setIsSelectingMarquee] = useState(false);
  const [selectionRect, setSelectionRect] = useState(null);
  
  const wrapperRef = useRef(null);
  const dragMetaRef = useRef(null);
  const selectionMetaRef = useRef(null);
  const rafRef = useRef(null);
  
  // Filtering states based on visibility controls
  const visibleSourceDocs = useMemo(() => {
    return sourceDocs.filter(d => !hiddenDocs.has(d.id));
  }, [sourceDocs, hiddenDocs]);

  const visibleTargetDocs = useMemo(() => {
    return targetDocs.filter(t => {
      if (!showLinkBoxes) return false;
      // Target is visible if at least one visible doc references it
      return Array.from(t.referencedByDocs).some(docId => !hiddenDocs.has(docId));
    });
  }, [targetDocs, showLinkBoxes, hiddenDocs]);

  const visibleEdges = useMemo(() => {
    return edges.filter(e => {
      if (e.edgeType === 'shared') {
        return !hiddenDocs.has(e.sourceDocId) && !hiddenDocs.has(e.targetDocId);
      } else if (e.edgeType === 'direct') {
        return showLinkBoxes && !hiddenDocs.has(e.sourceDocId);
      }
      return false;
    });
  }, [edges, showLinkBoxes, hiddenDocs]);

  // Undo capability tracking
  const historyRef = useRef([]);
  const latestNodeOffsetsRef = useRef(nodeOffsets);

  // Sync state cleanly when new docs are dynamically added into sourceDocs / targetDocs 
  useEffect(() => {
    setNodeOffsets((prev) => {
      let changed = false;
      const next = { ...prev };

      // Find the right-most extent safely
      let currentX = 50;
      Object.keys(prev).forEach((id) => {
        const pos = prev[id];
        const isDoc = sourceDocs.some((d) => d.id === id);
        const isTarget = targetDocs.some((t) => t.id === id);
        if (isDoc) currentX = Math.max(currentX, pos.x + 950);
        if (isTarget) currentX = Math.max(currentX, pos.x + 450);
      });

      sourceDocs.forEach((doc) => {
        if (!next[doc.id]) {
          next[doc.id] = { x: currentX, y: 50 };
          currentX += 950;
          changed = true;

          let currentTargetY = 50;
          let addedTargets = false;

          targetDocs.forEach((target) => {
            if (!next[target.id] && target.referencedByDocs?.has(doc.id)) {
              next[target.id] = { x: currentX, y: currentTargetY };
              currentTargetY += 200;
              addedTargets = true;
              changed = true;
            }
          });

          if (addedTargets) {
            currentX += 450;
          }
        }
      });

      // Dangling targets (if any target wasn't caught by the above loop)
      let currentTargetY = 50;
      targetDocs.forEach((target) => {
        if (!next[target.id]) {
          next[target.id] = { x: currentX, y: currentTargetY };
          currentTargetY += 200;
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [sourceDocs, targetDocs]);

  // Keep ref up to date with state
  useEffect(() => {
    latestNodeOffsetsRef.current = nodeOffsets;
  }, [nodeOffsets]);

  // Listen for Ctrl+Z / Cmd+Z for undo functionality
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (draggingNode || isSelectingMarquee) return; // Prevent undo during active action

        e.preventDefault();
        if (historyRef.current.length > 0) {
          const previousOffsets = historyRef.current.pop();
          setNodeOffsets(previousOffsets);
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [draggingNode, isSelectingMarquee]);

  const calculatePositions = useCallback(() => {
    if (!wrapperRef.current) return;

    const newPositions = {};
    const wrapperRect = wrapperRef.current.getBoundingClientRect();
    const trackers = wrapperRef.current.querySelectorAll('[data-track-id]');
    
    // Ratios correct for scaling via transform
    const xRatio = wrapperRect.width / wrapperRef.current.offsetWidth || 1;
    const yRatio = wrapperRect.height / wrapperRef.current.offsetHeight || 1;

    trackers.forEach((el) => {
      const id = el.getAttribute('data-track-id');
      const rect = el.getBoundingClientRect();

      // If it's a DOM element hidden by a scroll container, this bounding rect
      // will still be calculated accurately relative to the viewport.
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
  }, [calculatePositions, nodeOffsets, visibleSourceDocs, visibleTargetDocs]);

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

  // Hook to catch Marquee dispatched from App
  useEffect(() => {
    const handleStartMarquee = (e) => {
      if (!wrapperRef.current) return;
      
      const { clientX, clientY } = e.detail;
      const rect = wrapperRef.current.getBoundingClientRect();
      
      // Calculate start coordinates entirely relative to the component bounds + scale
      const localX = (clientX - rect.left) / currentScale;
      const localY = (clientY - rect.top) / currentScale;

      selectionMetaRef.current = {
        startX: localX,
        startY: localY,
        initialSelection: new Set(selectedNodes), // Track what was already selected
      };

      setSelectionRect({ startX: localX, startY: localY, currentX: localX, currentY: localY });
      setIsSelectingMarquee(true);
    };

    window.addEventListener('start-marquee', handleStartMarquee);
    return () => window.removeEventListener('start-marquee', handleStartMarquee);
  }, [selectedNodes, currentScale]);

  // Execute Marquee Event logic
  useEffect(() => {
    if (!isSelectingMarquee) return undefined;

    const handleMouseMove = (e) => {
      if (!selectionMetaRef.current || !wrapperRef.current) return;
      
      const rect = wrapperRef.current.getBoundingClientRect();
      
      // Calculate current mouse distance relative to transformed component scaling map
      const localX = (e.clientX - rect.left) / currentScale;
      const localY = (e.clientY - rect.top) / currentScale;
      
      const { startX, startY, initialSelection } = selectionMetaRef.current;

      setSelectionRect({ startX, startY, currentX: localX, currentY: localY });

      // Create boundary limits regardless of which direction the mouse moved!
      const boxMinX = Math.min(startX, localX);
      const boxMaxX = Math.max(startX, localX);
      const boxMinY = Math.min(startY, localY);
      const boxMaxY = Math.max(startY, localY);

      const nextSelection = new Set(initialSelection);

      // Check for intersections between selection box and tracked nodes via their scaled local maps
      Object.entries(nodePositions).forEach(([id, pos]) => {
        // Ensure we only select currently VISIBLE root docs and targets
        if (!visibleSourceDocs.find((d) => d.id === id) && !visibleTargetDocs.find((t) => t.id === id)) return;

        const nodeMinX = pos.left.x;
        const nodeMaxX = pos.right.x;
        const nodeMinY = pos.top.y;
        const nodeMaxY = pos.bottom.y;

        const intersects =
          nodeMinX < boxMaxX &&
          nodeMaxX > boxMinX &&
          nodeMinY < boxMaxY &&
          nodeMaxY > boxMinY;

        if (intersects) {
          nextSelection.add(id);
        }
      });

      setSelectedNodes(nextSelection);
    };

    const handleMouseUp = () => {
      setIsSelectingMarquee(false);
      setSelectionRect(null);
      selectionMetaRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isSelectingMarquee, currentScale, nodePositions, visibleSourceDocs, visibleTargetDocs, setSelectedNodes]);

  // Handle generalized Drag for Nodes
  useEffect(() => {
    if (!draggingNode) return undefined;

    const handleMouseMove = (e) => {
      if (!dragMetaRef.current) return;
      const { ids, startClientX, startClientY, startOffsets } = dragMetaRef.current;
      const dx = (e.clientX - startClientX) / currentScale;
      const dy = (e.clientY - startClientY) / currentScale;

      setNodeOffsets((prev) => {
        const nextOffsets = { ...prev };
        ids.forEach((id) => {
          if (startOffsets[id]) {
            nextOffsets[id] = {
              x: startOffsets[id].x + dx,
              y: startOffsets[id].y + dy,
            };
          }
        });
        return nextOffsets;
      });
    };

    const handleMouseUp = () => {
      if (dragMetaRef.current) {
        // Push pre-drag state to history to enable undo functionality
        const start = dragMetaRef.current.globalStartOffsets;
        const current = latestNodeOffsetsRef.current;
        if (start !== current) {
          historyRef.current.push(start);
          if (historyRef.current.length > 50) historyRef.current.shift(); // Keep history size manageable
        }
      }
      
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
              ? `Cross-Document Link: ${targetTitleMap.get(edge.sharedUrl) || edge.sharedUrl}`
              : targetTitleMap.get(edge.sharedUrl) || edge.sharedUrl,
        },
      ])
    );
  }, [edges, targetDocs]);

  const startNodeDrag = (e, id) => {
    e.stopPropagation();

    let newSelection = new Set(selectedNodes);

    // Multi-select toggle check
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      if (newSelection.has(id)) {
        newSelection.delete(id);
        setSelectedNodes(newSelection);
        return; // Don't initiate drag if we just deselected a node
      } else {
        newSelection.add(id);
      }
    } else {
      // Standard click on unselected node drops other selections
      if (!newSelection.has(id)) {
        newSelection = new Set([id]);
      }
    }

    setSelectedNodes(newSelection);

    // Save starting offsets for ALL selected nodes
    const startOffsets = {};
    newSelection.forEach((nodeId) => {
      startOffsets[nodeId] = nodeOffsets[nodeId] || { x: 0, y: 0 };
    });

    dragMetaRef.current = {
      ids: Array.from(newSelection),
      startClientX: e.clientX,
      startClientY: e.clientY,
      startOffsets,
      globalStartOffsets: latestNodeOffsetsRef.current, // Used for undo
    };
    
    setDraggingNode(id);
  };

  const getEdgePath = (edge) => {
    const from = nodePositions[edge.from];
    const to = nodePositions[edge.to];
    if (!from || !to) return null;

    // Determine the horizontal center points of both the source and the target bounds
    const fromCenterX = (from.left.x + from.right.x) / 2;
    const toCenterX = (to.left.x + to.right.x) / 2;

    let startX, startY, endX, endY, cp1x, cp2x;
    const isShared = edge.edgeType === 'shared';
    const minBow = isShared ? 80 : 50;

    if (fromCenterX <= toCenterX) {
      // Source is naturally to the left of Target. Link Right -> Left.
      startX = from.right.x;
      startY = from.right.y;
      endX = to.left.x;
      endY = to.left.y;
      
      const bow = Math.max(minBow, Math.abs(endX - startX) * 0.4);
      cp1x = startX + bow;
      cp2x = endX - bow;
    } else {
      // Source is naturally to the right of Target. Link Left -> Right.
      startX = from.left.x;
      startY = from.left.y;
      endX = to.right.x;
      endY = to.right.y;
      
      const bow = Math.max(minBow, Math.abs(endX - startX) * 0.4);
      cp1x = startX - bow;
      cp2x = endX + bow;
    }

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
            stroke={isSelected ? '#facc15' : '#a855f7'}
            strokeWidth={isSelected ? '4' : '3'}
            strokeDasharray="6 6"
            opacity={isSelected ? 1 : 0.85}
            className="transition-all duration-200"
            filter={isSelected ? 'drop-shadow(0 0 6px rgba(168, 85, 247, 0.8))' : undefined}
          />
          <circle cx={endX} cy={endY} r="4" fill={isSelected ? '#facc15' : '#a855f7'} />
          <circle cx={startX} cy={startY} r="4" fill={isSelected ? '#facc15' : '#a855f7'} />
        </g>
      );
    }

    return (
      <g key={`visual-${edge.id}`}>
        <defs>
          <linearGradient id={`grad-${edge.id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={isSelected ? '#facc15' : '#3b82f6'} stopOpacity={isSelected ? '0.95' : '0.45'} />
            <stop offset="100%" stopColor={isSelected ? '#f59e0b' : '#ec4899'} stopOpacity={isSelected ? '0.95' : '0.45'} />
          </linearGradient>
        </defs>
        <path
          d={path}
          fill="none"
          stroke={`url(#grad-${edge.id})`}
          strokeWidth={isSelected ? '5' : '2'}
          className="transition-all duration-200"
          filter={isSelected ? 'drop-shadow(0 0 8px rgba(250, 204, 21, 0.65))' : undefined}
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
    <div ref={wrapperRef} className="relative p-20 min-w-[2000px] min-h-[2000px]">
      {/* Marquee Selection Visual Box */}
      {selectionRect && (
        <div
          className="absolute border border-blue-400 bg-blue-500/20 z-50 pointer-events-none"
          style={{
            left: Math.min(selectionRect.startX, selectionRect.currentX),
            top: Math.min(selectionRect.startY, selectionRect.currentY),
            width: Math.abs(selectionRect.currentX - selectionRect.startX),
            height: Math.abs(selectionRect.currentY - selectionRect.startY),
          }}
        />
      )}

      {/* Source Documents (Fully Rendered) */}
      <div className="absolute top-0 left-0">
        {visibleSourceDocs.map((doc, idx) => (
          <div
            key={doc.id}
            data-track-id={doc.id}
            onMouseDown={(e) => startNodeDrag(e, doc.id)}
            className={`absolute w-[850px] flex flex-col bg-slate-50 border rounded-xl shadow-2xl overflow-hidden node-element cursor-move transition-[box-shadow,border-color] duration-150 ${
              selectedNodes.has(doc.id) ? 'border-blue-500 ring-4 ring-blue-500/40 z-30' : 'border-slate-300 z-20'
            }`}
            style={{ 
              transform: `translate(${nodeOffsets[doc.id]?.x || 0}px, ${nodeOffsets[doc.id]?.y || 0}px)`,
            }}
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <FileText className="w-5 h-5 text-blue-600 shrink-0" />
                <h3 className="font-bold text-slate-800 truncate text-sm">{doc.title}</h3>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(doc.url, '_blank', 'noopener,noreferrer');
                }}
                className="p-1.5 text-slate-400 hover:text-blue-600 rounded-lg transition-colors shrink-0"
              >
                <ExternalLink className="w-4 h-4" />
              </button>
            </div>

            {/* Document Content - Unconstrained Height */}
            <div 
              className="bg-white p-8 text-sm text-slate-800 leading-relaxed cursor-text"
              onMouseDown={(e) => e.stopPropagation()} 
            >
              {doc.blocks.map((block) => (
                <DocumentBlock key={block.id} block={block} calculatePositions={calculatePositions} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Target Link Nodes */}
      <div className="absolute top-0 left-0">
        {visibleTargetDocs.map((target, idx) => (
          <div
            key={target.id}
            data-track-id={target.id}
            onMouseDown={(e) => startNodeDrag(e, target.id)}
            className={`absolute w-[350px] bg-[#1e293b] border rounded-xl shadow-xl overflow-hidden node-element cursor-move transition-[box-shadow,border-color] duration-150 ${
              selectedNodes.has(target.id) ? 'border-blue-500 ring-4 ring-blue-500/40 z-30' : 'border-pink-500/30 z-20'
            }`}
            style={{ transform: `translate(${nodeOffsets[target.id]?.x || 0}px, ${nodeOffsets[target.id]?.y || 0}px)` }}
          >
            <div className="px-5 py-4 border-b border-slate-700/50 bg-pink-900/10 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <LinkIcon className="w-4 h-4 text-pink-400 shrink-0" />
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white truncate pr-2">{target.title}</h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-xs text-slate-400 truncate">{extractHostname(target.url)}</p>
                    <span className="px-1.5 py-0.5 rounded bg-pink-500/20 text-pink-300 text-[10px] font-bold tracking-wider uppercase">
                      {target.refCount} ref{target.refCount !== 1 && 's'}
                    </span>
                  </div>
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(target.url, '_blank', 'noopener,noreferrer');
                }}
                className="p-1.5 text-slate-400 hover:text-pink-400 rounded-lg transition-colors shrink-0"
                title="Open link"
              >
                <ExternalLink className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <svg
        className="absolute inset-0 z-20 pointer-events-none"
        style={{ width: '100%', height: '100%', overflow: 'visible' }}
      >
        {visibleEdges.filter((e) => e.edgeType === 'shared').map(renderVisualEdge)}
        {visibleEdges.filter((e) => e.edgeType === 'direct').map(renderVisualEdge)}
      </svg>

      <svg
        className="absolute inset-0 z-40 pointer-events-none"
        style={{ width: '100%', height: '100%', overflow: 'visible' }}
      >
        {visibleEdges.filter((e) => e.edgeType === 'shared').map(renderHitboxEdge)}
        {visibleEdges.filter((e) => e.edgeType === 'direct').map(renderHitboxEdge)}
      </svg>

      {selectedEdgeId && edgeMeta.get(selectedEdgeId) && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-slate-900/95 border border-yellow-400/40 shadow-2xl text-sm text-slate-100">
          {edgeMeta.get(selectedEdgeId).label}
        </div>
      )}
    </div>
  );
};