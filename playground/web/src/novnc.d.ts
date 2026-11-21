// noVNC 1.7 publishes an ESM root entry; its community types still name the earlier lib/rfb entry.
declare module "@novnc/novnc" {
  import RFB from "@novnc/novnc/lib/rfb";
  export default RFB;
}
