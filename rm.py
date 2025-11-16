#!/usr/bin/env python3
import os, re

def remove_logs(code):
    lines = code.split('\n')
    new_lines = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if re.search(r'console\.log\s*\(', line):
            match = re.search(r'console\.log\s*\(', line)
            accumulated = line[match.end():]
            paren_count = 1
            for char in accumulated:
                if char == '(': paren_count += 1
                elif char == ')':
                    paren_count -= 1
                    if paren_count == 0: break
            if paren_count == 0:
                i += 1
                continue
            else:
                i += 1
                while i < len(lines) and paren_count > 0:
                    for char in lines[i]:
                        if char == '(': paren_count += 1
                        elif char == ')':
                            paren_count -= 1
                            if paren_count == 0: break
                    i += 1
                continue
        new_lines.append(line)
        i += 1
    return '\n'.join(new_lines)

for root, dirs, files in os.walk('src'):
    dirs[:] = [d for d in dirs if not d.startswith('.') and d != 'node_modules']
    for file in files:
        if file.endswith('.js'):
            path = os.path.join(root, file)
            with open(path, 'r') as f:
                content = f.read()
            new_content = remove_logs(content)
            with open(path, 'w') as f:
                f.write(new_content)

print("✅ Done!")
