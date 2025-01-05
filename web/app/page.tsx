"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Check, Copy, Link, Loader2, Share2, Upload } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const CHUNK_SIZE = 16384;
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:8080";

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
    <div
      className={`min-h-screen bg-[#0A0118] bg-gradient-to-b from-purple-500/5 to-transparent `}
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 w-full min-h-screen py-8 sm:py-12 md:py-16">
        {/* Header */}
        <div className="text-center space-y-4">
          <h1 className="text-3xl sm:text-4xl md:text-6xl font-bold text-white tracking-tight">
            Send It
          </h1>
          <p className="text-base sm:text-lg text-purple-200/60 max-w-2xl mx-auto">
            Transfer files directly between browsers with end-to-end encryption.
            Fast, secure, and simple.
          </p>
        </div>

        <Card className="border-purple-500/20 bg-purple-500/5 backdrop-blur-xl shadow-2xl mt-10">
          <CardContent className="p-6">
            {!roomId ? (
              <div className="flex flex-col items-center gap-8 py-16">
                <Button
                  size="lg"
                  onClick={createRoom}
                  className="w-full max-w-sm bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-500/25 transition-all hover:scale-105"
                >
                  <Share2 className="mr-2 h-5 w-5" />
                  Create Secure Room
                </Button>
                <p className="text-sm text-purple-200/60 text-center max-w-md">
                  Create a private room to start sharing files securely with
                  another person. All transfers are peer-to-peer and encrypted.
                </p>
              </div>
            ) : (
              <div className="space-y-8">
                {roomUrl && (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-lg font-semibold text-white mb-1">
                        Share Room Link
                      </h3>
                      <p className="text-sm text-purple-200/60">
                        Send this link to the person you want to share files
                        with
                      </p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <Input
                        value={roomUrl}
                        readOnly
                        className="bg-purple-950/50 border-purple-500/20 text-purple-100"
                      />
                      <Button
                        variant="secondary"
                        onClick={() => {
                          navigator.clipboard.writeText(roomUrl);
                          setMessages((prev) => [
                            ...prev,
                            "Room URL copied to clipboard",
                          ]);
                        }}
                        className="bg-purple-600/10 hover:bg-purple-600/20 text-purple-100 w-full sm:w-auto"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}

                <div className="space-y-6">
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
                    <Button
                      onClick={createOffer}
                      disabled={!connected}
                      variant="outline"
                      className="border-purple-500/20 text-black hover:bg-gray-200 w-full sm:w-auto"
                    >
                      {connected ? (
                        <>
                          <Link className="mr-2 h-4 w-4" />
                          Connect Peer
                        </>
                      ) : (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Connecting...
                        </>
                      )}
                    </Button>

                    <div className="relative flex-1">
                      <Input
                        type="file"
                        onChange={(e) =>
                          e.target.files?.[0] && sendFile(e.target.files[0])
                        }
                        disabled={
                          !dataChannelRef.current ||
                          dataChannelRef.current.readyState !== "open"
                        }
                        className="w-full bg-white hover:bg-gray-200 text-black"
                      />
                    </div>
                  </div>

                  {downloadReady && currentFile && (
                    <Alert className="bg-green-500/10 border-green-500/20">
                      <Check className="h-4 w-4 text-white" />
                      <AlertDescription className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-white">
                        <span className="break-all">
                          Ready to download: {currentFile.name}
                        </span>
                        <Button
                          onClick={downloadFile}
                          variant="outline"
                          className="border-green-500/20 text-black hover:bg-gray w-full sm:w-auto"
                        >
                          Download File
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}
                </div>

                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-white">
                    Connection Status
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <p className="text-sm text-purple-200/60">Room ID</p>
                      <Badge
                        variant="outline"
                        className="border-purple-500/20 text-purple-100"
                      >
                        {roomId}
                      </Badge>
                    </div>
                    <div className="space-y-2">
                      <p className="text-sm text-purple-200/60">
                        Server Status
                      </p>
                      <Badge
                        variant={connected ? "success" : "destructive"}
                        className={
                          connected ? "bg-green-500/10 text-green-100" : ""
                        }
                      >
                        {connected ? "Connected" : "Disconnected"}
                      </Badge>
                    </div>
                    <div className="space-y-2">
                      <p className="text-sm text-purple-200/60">Data Channel</p>
                      <Badge
                        variant="outline"
                        className="border-purple-500/20 text-purple-100"
                      >
                        {dataChannelRef.current?.readyState || "Not Created"}
                      </Badge>
                    </div>
                  </div>

                  {(sendProgress || receiveProgress) && (
                    <div className="space-y-6 mt-6">
                      {sendProgress && (
                        <div className="space-y-2">
                          <div className="flex justify-between text-sm text-purple-100">
                            <span>Sending: {sendProgress.name}</span>
                            <span>{Math.round(sendProgress.progress)}%</span>
                          </div>
                          <Progress
                            value={sendProgress.progress}
                            className="h-2 bg-purple-950/50"
                          />
                          <p className="text-sm text-purple-200/60">
                            {sendProgress.currentChunk} of{" "}
                            {sendProgress.totalChunks} chunks
                          </p>
                        </div>
                      )}

                      {receiveProgress && (
                        <div className="space-y-2">
                          <div className="flex justify-between text-sm text-purple-100">
                            <span>Receiving: {receiveProgress.name}</span>
                            <span>{Math.round(receiveProgress.progress)}%</span>
                          </div>
                          <Progress
                            value={receiveProgress.progress}
                            className="h-2 bg-purple-950/50"
                          />
                          <p className="text-sm text-purple-200/60">
                            {receiveProgress.currentChunk} of{" "}
                            {receiveProgress.totalChunks} chunks
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-white">
                    Activity Log
                  </h3>
                  <div className="max-h-[200px] overflow-y-auto space-y-2 rounded-lg bg-purple-950/30 p-4">
                    {messages.map((msg, index) => (
                      <div key={index} className="text-sm text-purple-200/60">
                        {msg}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default WebrtcPage;
