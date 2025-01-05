"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const CHUNK_SIZE = 16384;
const BASE_URL = "http://localhost:8080";

interface FileTransfer {
  name: string;
  size: number;
  type: string;
  currentChunk: number;
  totalChunks: number;
  progress: number;
}

const WebrtcPage = () => {
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [sendProgress, setSendProgress] = useState<FileTransfer | null>(null);
  const [receiveProgress, setReceiveProgress] = useState<FileTransfer | null>(
    null
  );
  const [downloadReady, setDownloadReady] = useState(false);
  const [currentFile, setCurrentFile] = useState<{
    name: string;
    url: string;
  } | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomUrl, setRoomUrl] = useState<string>("");

  const socketRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const fileChunksRef = useRef<Uint8Array[]>([]);
  const receivedSizeRef = useRef<number>(0);

  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    const roomFromUrl = searchParams.get("room");
    if (roomFromUrl) {
      setRoomId(roomFromUrl);
      connectToSignalingServer(roomFromUrl);
    }
  }, [searchParams]);

  const createRoom = async () => {
    try {
      const response = await fetch(`${BASE_URL}/create-room`, {
        method: "POST",
      });
      const data = await response.json();
      const newRoomId = data.roomId;

      setRoomId(newRoomId);
      const url = `${window.location.origin}${window.location.pathname}?room=${newRoomId}`;
      setRoomUrl(url);

      connectToSignalingServer(newRoomId);
    } catch (error) {
      console.error("Error creating room:", error);
      setMessages((prev) => [...prev, `Error creating room: ${error}`]);
    }
  };

  const connectToSignalingServer = (roomId: string) => {
    const socket = new WebSocket(`ws://localhost:8080/ws?room=${roomId}`);
    socketRef.current = socket;

    socket.onopen = () => {
      console.log("Connected to signaling server");
      setConnected(true);
      setMessages((prev) => [...prev, `Connected to room: ${roomId}`]);
    };

    socket.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      console.log("Received message:", message);

      try {
        switch (message.type) {
          case "offer":
            await handleOffer(message.sdp);
            break;
          case "answer":
            await handleAnswer(message.sdp);
            break;
          case "ice_candidate":
            if (message.candidate) {
              await handleICECandidate(message.candidate);
            }
            break;
        }
      } catch (error) {
        console.error("Error handling message:", error);
      }
    };

    socket.onerror = (error) => {
      console.error("WebSocket error:", error);
      setMessages((prev) => [...prev, `Error: ${error.toString()}`]);
    };

    socket.onclose = () => {
      console.log("Disconnected from signaling server");
      setConnected(false);
    };
  };

  const setupPeerConnection = () => {
    const config = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    };

    const pc = new RTCPeerConnection(config);
    peerConnectionRef.current = pc;

    // create a data channel
    const dataChannel = pc.createDataChannel("fileTransfer", {
      ordered: true,
    });
    dataChannelRef.current = dataChannel;

    setupDataChannelHandlers(dataChannel);

    // ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        const message = {
          type: "ice_candidate",
          candidate: event.candidate.toJSON(),
        };
        socketRef.current.send(JSON.stringify(message));
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      dataChannelRef.current = channel;
      setupDataChannelHandlers(channel);
    };

    return pc;
  };

  const setupDataChannelHandlers = (channel: RTCDataChannel) => {
    channel.binaryType = "arraybuffer";
    let expectedFileMetadata: FileTransfer | null = null;

    channel.onopen = () => {
      console.log("Data channel opened");
      setMessages((prev) => [...prev, "Data channel opened"]);
    };

    channel.onmessage = async (event) => {
      console.log("Received data type:", typeof event.data);

      if (typeof event.data === "string") {
        try {
          console.log("Received string data:", event.data);
          const metadata = JSON.parse(event.data);

          if (metadata.type === "file-start") {
            console.log("File transfer starting:", metadata);

            expectedFileMetadata = {
              name: metadata.name,
              size: metadata.size,
              type: metadata.fileType,
              currentChunk: 0,
              totalChunks: metadata.totalChunks,
              progress: 0,
            };

            // reset all state for new transfer
            fileChunksRef.current = [];
            receivedSizeRef.current = 0;

            setReceiveProgress(expectedFileMetadata);
          } else if (metadata.type === "file-end") {
            console.log("File transfer complete, checking integrity...");
            console.log("Received size:", receivedSizeRef.current);
            console.log("Expected size:", expectedFileMetadata?.size);
            console.log("Number of chunks:", fileChunksRef.current.length);

            if (
              expectedFileMetadata?.size &&
              receivedSizeRef.current > 0 &&
              Math.abs(receivedSizeRef.current - expectedFileMetadata.size) <= 1
            ) {
              console.log("Size verification passed, initiating download...");
              if (expectedFileMetadata) {
                await handleFileReceived(expectedFileMetadata);
              }
            } else {
              const error = `Size mismatch - Received: ${receivedSizeRef.current}, Expected: ${expectedFileMetadata?.size}`;
              console.error(error);
              setMessages((prev) => [...prev, `Error: ${error}`]);
            }
          }
        } catch (error) {
          console.error("Error processing message:", error);
          setMessages((prev) => [
            ...prev,
            `Error processing message: ${error}`,
          ]);
        }
      } else {
        try {
          const chunk = new Uint8Array(event.data);
          console.log("Received chunk size:", chunk.length);

          if (chunk.length > 0 && expectedFileMetadata) {
            fileChunksRef.current.push(chunk);
            receivedSizeRef.current += chunk.length;

            const currentChunk = fileChunksRef.current.length;
            const progress = Math.min(
              (receivedSizeRef.current / expectedFileMetadata.size) * 100,
              100
            );

            console.log(
              `Progress update - Chunk: ${currentChunk}, Size: ${receivedSizeRef.current}, Progress: ${progress}%`
            );

            setReceiveProgress({
              ...expectedFileMetadata,
              currentChunk,
              progress,
            });
          } else {
            console.warn("Received empty chunk or missing metadata");
          }
        } catch (error) {
          console.error("Error processing chunk:", error);
          setMessages((prev) => [...prev, `Error processing chunk: ${error}`]);
        }
      }
    };

    channel.onerror = (error) => {
      console.error("Data channel error:", error);
      setMessages((prev) => [
        ...prev,
        `Data channel error: ${error.toString()}`,
      ]);
    };

    channel.onclose = () => {
      console.log("Data channel closed");
      setMessages((prev) => [...prev, "Data channel closed"]);
    };
  };

  const handleFileReceived = async (metadata: FileTransfer) => {
    try {
      console.log("Starting file assembly...");
      const combinedArray = new Uint8Array(receivedSizeRef.current);
      let offset = 0;

      for (const chunk of fileChunksRef.current) {
        combinedArray.set(chunk, offset);
        offset += chunk.length;
      }

      const blob = new Blob([combinedArray], { type: metadata.type });
      const url = URL.createObjectURL(blob);

      setCurrentFile({ name: metadata.name, url });
      setDownloadReady(true);

      setMessages((prev) => [...prev, `File received: ${metadata.name}`]);

      // clean up state
      fileChunksRef.current = [];
      receivedSizeRef.current = 0;
    } catch (error) {
      console.error("Error in handleFileReceived:", error);
      setMessages((prev) => [
        ...prev,
        `Error handling received file: ${error}`,
      ]);
    }
  };
  const downloadFile = () => {
    if (currentFile) {
      const a = document.createElement("a");
      a.href = currentFile.url;
      a.download = currentFile.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // clean up
      URL.revokeObjectURL(currentFile.url);
      setCurrentFile(null);
      setDownloadReady(false);
      setReceiveProgress(null);
    }
  };
  const sendFile = async (file: File) => {
    if (
      !dataChannelRef.current ||
      dataChannelRef.current.readyState !== "open"
    ) {
      setMessages((prev) => [...prev, "No open data channel"]);
      return;
    }

    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      console.log(
        `Starting file transfer: ${file.name}, size: ${file.size}, chunks: ${totalChunks}`
      );

      const metadata = {
        type: "file-start",
        name: file.name,
        size: file.size,
        fileType: file.type,
        totalChunks,
      };
      console.log("Sending metadata:", metadata);
      dataChannelRef.current.send(JSON.stringify(metadata));

      setSendProgress({
        name: file.name,
        size: file.size,
        type: file.type,
        currentChunk: 0,
        totalChunks,
        progress: 0,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const reader = new FileReader();
      let offset = 0;

      const readNextChunk = () => {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
      };

      reader.onload = async () => {
        if (!reader.result || !dataChannelRef.current) return;

        try {
          dataChannelRef.current.send(reader.result);
          console.log(
            `Sent chunk at offset: ${offset}, size: ${reader.result.byteLength}`
          );

          offset += CHUNK_SIZE;
          const currentChunk = Math.floor(offset / CHUNK_SIZE);
          setSendProgress((prev) =>
            prev
              ? {
                  ...prev,
                  currentChunk,
                  progress: (offset / file.size) * 100,
                }
              : null
          );

          // adding a small delay between chunks to prevent overwhelming the data channel
          await new Promise((resolve) => setTimeout(resolve, 5));

          if (offset < file.size) {
            readNextChunk();
          } else {
            console.log("Sending file-end marker");
            dataChannelRef.current.send(JSON.stringify({ type: "file-end" }));
            setSendProgress(null);
            setMessages((prev) => [...prev, `File sent: ${file.name}`]);
          }
        } catch (error) {
          console.error("Error sending chunk:", error);
          setMessages((prev) => [
            ...prev,
            `Error sending file: ${error.toString()}`,
          ]);
        }
      };

      reader.onerror = (error) => {
        console.error("Error reading file:", error);
        setMessages((prev) => [
          ...prev,
          `Error reading file: ${error.toString()}`,
        ]);
      };

      readNextChunk();
    } catch (error) {
      console.error("Error in sendFile:", error);
      setMessages((prev) => [
        ...prev,
        `Error sending file: ${error.toString()}`,
      ]);
    }
  };

  const createOffer = async () => {
    const pc = setupPeerConnection();

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (socketRef.current) {
        socketRef.current.send(
          JSON.stringify({
            type: "offer",
            sdp: offer.sdp,
          })
        );
      }
    } catch (error) {
      console.error("Error creating offer:", error);
      setMessages((prev) => [...prev, `Error creating offer: ${error}`]);
    }
  };

  const handleOffer = async (sdp: string) => {
    const pc = setupPeerConnection();

    try {
      await pc.setRemoteDescription(
        new RTCSessionDescription({
          type: "offer",
          sdp,
        })
      );

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (socketRef.current) {
        socketRef.current.send(
          JSON.stringify({
            type: "answer",
            sdp: answer.sdp,
          })
        );
      }
    } catch (error) {
      console.error("Error handling offer:", error);
      setMessages((prev) => [...prev, `Error handling offer: ${error}`]);
    }
  };

  const handleAnswer = async (sdp: string) => {
    try {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp })
        );
      }
    } catch (error) {
      console.error("Error handling answer:", error);
      setMessages((prev) => [...prev, `Error handling answer: ${error}`]);
    }
  };

  const handleICECandidate = async (candidate: RTCIceCandidateInit) => {
    try {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.addIceCandidate(
          new RTCIceCandidate(candidate)
        );
      }
    } catch (error) {
      console.error("Error handling ICE candidate:", error);
      setMessages((prev) => [
        ...prev,
        `Error handling ICE candidate: ${error}`,
      ]);
    }
  };

  const sendMessage = () => {
    if (dataChannelRef.current?.readyState === "open") {
      const message = "Hello from peer!";
      dataChannelRef.current.send(message);
      setMessages((prev) => [...prev, `Sent: ${message}`]);
    } else {
      setMessages((prev) => [...prev, "Data channel not open"]);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">WebRTC P2P File Sharing</h1>

      <div className="space-y-6">
        {!roomId ? (
          <div className="flex flex-col gap-4">
            <button
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition w-full md:w-auto"
              onClick={createRoom}
            >
              Create New Room
            </button>
            <p className="text-sm text-gray-600">
              Create a room to start sharing files securely with another person.
            </p>
          </div>
        ) : (
          <>
            {roomUrl && (
              <div className="p-4 bg-gray-50 rounded-lg border">
                <p className="mb-2 font-medium">
                  Share this link with the recipient:
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={roomUrl}
                    readOnly
                    className="flex-1 p-2 border rounded bg-white"
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(roomUrl);
                      setMessages((prev) => [
                        ...prev,
                        "Room URL copied to clipboard",
                      ]);
                    }}
                    className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 transition"
                  >
                    Copy Link
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4">
                <button
                  className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-400 transition"
                  onClick={createOffer}
                  disabled={!connected}
                >
                  Create Connection
                </button>

                <input
                  type="file"
                  onChange={(e) =>
                    e.target.files?.[0] && sendFile(e.target.files[0])
                  }
                  disabled={
                    !dataChannelRef.current ||
                    dataChannelRef.current.readyState !== "open"
                  }
                  className="block w-full text-sm text-slate-500
                file:mr-4 file:py-2 file:px-4
                file:rounded-full file:border-0
                file:text-sm file:font-semibold
                file:bg-violet-50 file:text-violet-700
                hover:file:bg-violet-100"
                />
              </div>

              {downloadReady && currentFile && (
                <div className="flex items-center gap-4 p-4 bg-green-50 rounded-lg">
                  <span className="text-green-700">
                    File ready: {currentFile.name}
                  </span>
                  <button
                    onClick={downloadFile}
                    className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 transition"
                  >
                    Download File
                  </button>
                </div>
              )}
            </div>

            <div className="border rounded-lg p-6 bg-gray-50 shadow-sm">
              <h2 className="text-xl font-semibold mb-4">Transfer Status</h2>

              <div className="space-y-2 mb-4">
                <p className="text-gray-700">
                  Room:{" "}
                  <span className="font-medium text-blue-600">{roomId}</span>
                </p>
                <p className="text-gray-700">
                  Server:{" "}
                  <span
                    className={`font-medium ${
                      connected ? "text-green-600" : "text-red-600"
                    }`}
                  >
                    {connected ? "Connected" : "Disconnected"}
                  </span>
                </p>
                <p className="text-gray-700">
                  Data Channel:{" "}
                  <span className="font-medium">
                    {dataChannelRef.current?.readyState || "not created"}
                  </span>
                </p>
              </div>

              {(sendProgress || receiveProgress) && (
                <div className="space-y-4">
                  {sendProgress && (
                    <div className="bg-white p-4 rounded-lg shadow-sm">
                      <h3 className="font-semibold text-blue-700 mb-2">
                        Sending: {sendProgress.name}
                      </h3>
                      <div className="w-full bg-gray-200 rounded-full h-2.5">
                        <div
                          className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                          style={{ width: `${sendProgress.progress}%` }}
                        ></div>
                      </div>
                      <p className="text-sm text-gray-600 mt-2">
                        {Math.round(sendProgress.progress)}% (
                        {sendProgress.currentChunk} of{" "}
                        {sendProgress.totalChunks} chunks)
                      </p>
                    </div>
                  )}

                  {receiveProgress && (
                    <div className="bg-white p-4 rounded-lg shadow-sm">
                      <h3 className="font-semibold text-green-700 mb-2">
                        Receiving: {receiveProgress.name}
                      </h3>
                      <div className="w-full bg-gray-200 rounded-full h-2.5">
                        <div
                          className="bg-green-600 h-2.5 rounded-full transition-all duration-300"
                          style={{ width: `${receiveProgress.progress}%` }}
                        ></div>
                      </div>
                      <p className="text-sm text-gray-600 mt-2">
                        {Math.round(receiveProgress.progress)}% (
                        {receiveProgress.currentChunk} of{" "}
                        {receiveProgress.totalChunks} chunks)
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="border rounded-lg p-4 max-h-[300px] overflow-y-auto bg-white shadow-sm">
              <h2 className="font-semibold mb-2">Messages:</h2>
              {messages.map((msg, index) => (
                <div key={index} className="py-1 text-gray-700">
                  {msg}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default WebrtcPage;
