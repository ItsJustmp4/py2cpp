s = input()
cnt = 0
for ch in s:
    if ch.isdigit():
        cnt += 1
print("цифр:", cnt)
print(s.replace("a", "A"), s.count("a"), s.find("b"))
r = s.strip().lower()
print(r * 2)
parts = "1,2,3".split(",")
nums = list(map(int, parts))
print(sum(nums))
print(f"{len(s)} символов, {cnt / len(s):.3f} доля")
word = "level"
print("да" if word == word[::-1] else "нет")
print(word[::-1], word[1:3], word[-2:], word[:-1])
arr = [1, 2, 3, 4, 5]
print(arr[1:4], arr[::2], arr[::-1])
print([1.5, 2.0], [True], ['x'])
