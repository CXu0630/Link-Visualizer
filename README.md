# GDoc Link Visualizer

The link visualizer is a separate tool from the linker, but can be used in conjunction with it to view created links. It provides a visual interface, currently built for Google Docs, that tracks links within documents. The interface provides a simple render of Google Docs and represents links as nodes. Hypertext with a certain link is connected visually to that node. Hypertext that shares a link is connected to the same node. Multiple documents can be rendered at the same time. In this case, hypertext that shares the same link is also visually connected. 

This tool is intended to help visualize connectivity between two hypertext documents. Visual link density indicates how often two documents reference the same sources. It can also be used as an editing tool. When updating links within text, the visualizer can show when stale links persist.

Once features such as HTML rendering are integrated into the visualizer, it can become a way to navigate information. The interface becomes a graph representation of interconnected documents. By “exploring” a node, its connections are brought into the graph.
