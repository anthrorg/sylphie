// Type shim: cytoscape-fcose has no @types package; this lets TS accept the import
declare module 'cytoscape-fcose' {
  import { Ext } from 'cytoscape'
  const ext: Ext
  export default ext
}
