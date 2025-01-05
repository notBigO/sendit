package main

import (
	"log"
	"net/http"
	"sendit/internal/config"
	"sendit/internal/handlers"
)

func main() {
	http.HandleFunc("/ws", handlers.HandleWebSocket)

	port := config.ServerPort
	log.Printf("Starting signaling server on %s", port)
	if err := http.ListenAndServe(port, nil); err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}
