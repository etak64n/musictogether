# Builds the room server as a static binary and runs it in an image without a
# shell or package manager, as an unprivileged user.
FROM golang:1.27.1-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /musictogether . \
 && mkdir /data

FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.title="musictogether" \
      org.opencontainers.image.description="The room server of Music Together: listen to YouTube Music with friends at the same moment" \
      org.opencontainers.image.source="https://github.com/etak64n/musictogether" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /musictogether /musictogether
# A named volume mounted here starts out owned by the nonroot user.
COPY --from=build --chown=nonroot:nonroot /data /data
ENTRYPOINT ["/musictogether"]
