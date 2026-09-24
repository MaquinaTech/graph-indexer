/*
 * The Java compiler's answer to "which lines use this declaration" (the counterpart of
 * bench/oracle-go for bench/eval-graph-java.mjs). javac parses and attributes every .java file of
 * the given source directories (dependencies that are not on the class path become error types;
 * what the repository declares still resolves), then every identifier, member access and method
 * reference is bound to the element it names.
 *
 *   java bench/oracle-java/Oracle.java <root> <srcdir>[,<srcdir>…] < queries.tsv > answers.json
 *
 * Queries, one per line: path<TAB>line<TAB>name, the line of a declared name. Answers, in order:
 *   exact     every line with a use of that element (import lines and the declaration excluded);
 *   dispatch  exact plus, for a method, the uses of the methods it overrides or implements (a call
 *             through the supertype may run it) and of the methods that override it.
 * Output: {"files":[…], "answers":[{"exact":[…],"dispatch":[…]} | null]}
 */
import com.sun.source.tree.*;
import com.sun.source.util.*;

import javax.lang.model.element.*;
import javax.lang.model.util.Elements;
import javax.tools.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.*;
import java.util.stream.*;

public class Oracle {
    public static void main(String[] args) throws Exception {
        Path root = Paths.get(args[0]).toAbsolutePath().normalize();
        List<Path> files = new ArrayList<>();
        for (String d : args[1].split(",")) {
            try (Stream<Path> s = Files.walk(root.resolve(d))) {
                s.filter(p -> p.toString().endsWith(".java")).sorted().forEach(files::add);
            }
        }
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        StandardJavaFileManager fm = javac.getStandardFileManager(null, null, StandardCharsets.UTF_8);
        JavacTask task = (JavacTask) javac.getTask(null, fm, d -> { }, List.of("-proc:none", "-nowarn", "-Xlint:none", "-implicit:none"), null,
                fm.getJavaFileObjectsFromPaths(files));
        Iterable<? extends CompilationUnitTree> units = task.parse();
        task.analyze();
        Trees trees = Trees.instance(task);
        SourcePositions sp = trees.getSourcePositions();
        Elements elements = task.getElements();

        Map<Element, Set<String>> uses = new HashMap<>();
        Map<String, Element> decls = new HashMap<>();          // "path:line:name" → element
        Map<Element, String> declLine = new HashMap<>();       // element → "path:line"
        List<ExecutableElement> methods = new ArrayList<>();
        List<String> fileList = new ArrayList<>();

        for (CompilationUnitTree cu : units) {
            String rel = root.relativize(Paths.get(cu.getSourceFile().toUri())).toString().replace('\\', '/');
            fileList.add(rel);
            String text = cu.getSourceFile().getCharContent(true).toString();
            LineMap lines = cu.getLineMap();
            new TreePathScanner<Void, Void>() {
                void use(Tree t, long namePos) {
                    Element e = trees.getElement(getCurrentPath());
                    if (e == null || namePos < 0) return;
                    uses.computeIfAbsent(e, k -> new HashSet<>()).add(rel + ":" + lines.getLineNumber(namePos));
                }
                void decl(Tree t, String name, Pattern at) {
                    Element e = trees.getElement(getCurrentPath());
                    if (e == null) return;
                    long start = sp.getStartPosition(cu, t), end = sp.getEndPosition(cu, t);
                    if (start < 0) return;
                    Matcher m = at.matcher(text);
                    m.region((int) start, (int) Math.min(text.length(), end < 0 ? text.length() : end));
                    if (!m.find()) return;
                    long line = lines.getLineNumber(m.start(1));
                    decls.put(rel + ":" + line + ":" + name, e);
                    declLine.put(e, rel + ":" + line);
                    if (e instanceof ExecutableElement x && e.getKind() == ElementKind.METHOD) methods.add(x);
                }
                @Override public Void visitImport(ImportTree t, Void v) { return null; }
                @Override public Void visitClass(ClassTree t, Void v) {
                    String n = t.getSimpleName().toString();
                    if (!n.isEmpty()) decl(t, n, Pattern.compile("\\b(?:class|interface|enum|record)\\s+(" + Pattern.quote(n) + ")\\b"));
                    return super.visitClass(t, v);
                }
                @Override public Void visitMethod(MethodTree t, Void v) {
                    String n = t.getName().toString();
                    if (!n.equals("<init>")) decl(t, n, Pattern.compile("\\b(" + Pattern.quote(n) + ")\\s*\\("));
                    return super.visitMethod(t, v);
                }
                @Override public Void visitIdentifier(IdentifierTree t, Void v) {
                    use(t, sp.getStartPosition(cu, t));
                    return super.visitIdentifier(t, v);
                }
                @Override public Void visitMemberSelect(MemberSelectTree t, Void v) {
                    long end = sp.getEndPosition(cu, t);
                    use(t, end < 0 ? -1 : end - t.getIdentifier().length());
                    return super.visitMemberSelect(t, v);
                }
                @Override public Void visitMemberReference(MemberReferenceTree t, Void v) {
                    long end = sp.getEndPosition(cu, t);
                    use(t, end < 0 ? -1 : end - t.getName().length());
                    return super.visitMemberReference(t, v);
                }
            }.scan(cu, null);
        }

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder("{\"files\":").append(json(fileList)).append(",\"answers\":[");
        String q;
        boolean first = true;
        while ((q = in.readLine()) != null) {
            if (q.isBlank()) continue;
            String[] f = q.split("\t");
            Element e = decls.get(f[0] + ":" + f[1] + ":" + f[2]);
            if (!first) out.append(',');
            first = false;
            if (e == null) { out.append("null"); continue; }
            String self = declLine.get(e);
            Set<String> exact = new TreeSet<>(uses.getOrDefault(e, Set.of()));
            exact.remove(self);
            Set<String> dispatch = new TreeSet<>(exact);
            if (e instanceof ExecutableElement m) {
                for (ExecutableElement o : methods) {
                    if (o == m || !o.getSimpleName().equals(m.getSimpleName())) continue;
                    if (elements.overrides(m, o, (TypeElement) m.getEnclosingElement()) || elements.overrides(o, m, (TypeElement) o.getEnclosingElement()))
                        dispatch.addAll(uses.getOrDefault(o, Set.of()));
                }
                dispatch.remove(self);
            }
            out.append("{\"exact\":").append(json(exact)).append(",\"dispatch\":").append(json(dispatch)).append('}');
        }
        out.append("]}");
        System.out.println(out);
    }

    static String json(Collection<String> xs) {
        return xs.stream().map(x -> "\"" + x.replace("\\", "\\\\").replace("\"", "\\\"") + "\"").collect(Collectors.joining(",", "[", "]"));
    }
}
