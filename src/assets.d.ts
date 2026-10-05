declare module "*.bin" {
  const path: string;
  export default path;
}

declare module "*.dylib" {
  const path: string;
  export default path;
}

declare module "*.so.1" {
  const path: string;
  export default path;
}

declare module "*.md" {
  const text: string;
  export default text;
}
